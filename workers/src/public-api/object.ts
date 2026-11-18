/**
 * Public API and API key management inside the shop object (spec 14.1, 11.2 `api_keys`).
 *
 *  - `handlePublicCall`: the Worker has checked the seal and chosen this object from the key; here
 *    the key is found by its prefix, the SHA-256 of its secret compared in constant time, revocation
 *    and scopes checked, the request counted (token bucket), then the SAME handlers as `/api/v1`
 *    run through `handleApiCall` with a public `Principal` (no business logic here).
 *  - `handleApiKeysCall`: `GET/POST/DELETE /api-keys` of the internal surface (administrators only;
 *    O5: never reachable with an API key, so a stolen key cannot create others).
 */
import {
  API_SCOPES,
  PUBLIC_ROUTES,
  type ApiKey,
  type ApiScope,
  type CreateApiKeyRequest,
  type CreateApiKeyResponse,
  type CreateUnitRequest,
  type CreateUnitsBatchRequest,
  type CreateUnitsBatchResponse,
  type PublicRouteName,
} from '@serialis/contract';
import { handleApiCall, type ShopInfo } from '../api/router.js';
import { anomalyActions } from '../api/present.js';
import { iso, json, noContent, problem, unitEtag, type ApiCall, type ApiResult, type Principal } from '../api/http.js';
import type { DomainContext } from '../domain/context.js';
import type { Env } from '../env.js';
import { timingSafeEqual } from '../hmac.js';
import { errorMessage, logEvent } from '../log.js';
import { currentSealVersion, issueApiKey, keyHint, secretHash, type KeyLocation } from './keys.js';
import { rateLimitHeaders, type TokenBucketLimiter } from './rate-limit.js';

/** What the Worker hands to the object for a public call; `call.principal` is set here, after authentication. */
export interface PublicApiInput {
  call: Omit<ApiCall, 'principal'>;
  shop: string;
  prefix: string;
  secret: string;
}

type ApiKeyRow = {
  prefix: string;
  name: string;
  hash: ArrayBuffer;
  scopes: string;
  seal_version: number;
  location: KeyLocation;
  created_by: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

/** `last_used_at` is written at most once a minute per key (no write per request). */
const LAST_USED_RESOLUTION_MS = 60_000;
const MAX_ACTIVE_KEYS = 50;

const UNAUTHENTICATED_HEADERS = { 'WWW-Authenticate': 'Bearer realm="serialis", error="invalid_token"' };

export function invalidKey(detail = 'invalid_api_key'): ApiResult {
  return problem(401, 'unauthenticated', detail, undefined, UNAUTHENTICATED_HEADERS);
}

// ------------------------------------------------------------------------------------------ route table

interface CompiledPublicRoute {
  name: PublicRouteName;
  method: string;
  regex: RegExp;
  params: string[];
  scope: ApiScope;
}

const COMPILED: CompiledPublicRoute[] = (Object.entries(PUBLIC_ROUTES) as Array<[PublicRouteName, { route: string; scope: ApiScope }]>)
  .map(([name, def]) => {
    const [method, path] = def.route.split(' ') as [string, string];
    const params: string[] = [];
    const regex = new RegExp(
      `^${path
        .split('/')
        .map((seg) => {
          const m = /^\{(\w+)\}$/.exec(seg);
          if (!m) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          params.push(m[1]!);
          return '([^/]+)';
        })
        .join('/')}$`,
    );
    return { name, method, regex, params, scope: def.scope };
  })
  // Static segments win over parameters (`/units/batch` before `/units/{id}`).
  .sort((a, b) => a.params.length - b.params.length);

export function matchPublicRoute(method: string, path: string): { route: CompiledPublicRoute; params: Record<string, string> } | { allowed: string[] } | null {
  const allowed: string[] = [];
  for (const route of COMPILED) {
    const m = route.regex.exec(path);
    if (!m) continue;
    if (route.method !== method) {
      allowed.push(route.method);
      continue;
    }
    const params: Record<string, string> = {};
    route.params.forEach((p, i) => (params[p] = safeDecode(m[i + 1]!)));
    return { route, params };
  }
  return allowed.length > 0 ? { allowed } : null;
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

// ------------------------------------------------------------------------------------------ public calls

export interface PublicDeps {
  limiter: TokenBucketLimiter;
  info: () => ShopInfo;
  now?: number;
}

export async function handlePublicCall(d: DomainContext, input: PublicApiInput, deps: PublicDeps): Promise<ApiResult> {
  const now = deps.now ?? Date.now();
  // A key sealed for another shop name cannot reach this object; checked anyway (defence in depth).
  if (input.shop !== d.shopDomain) return invalidKey();
  const row = d.sql.exec<ApiKeyRow>('SELECT * FROM api_keys WHERE prefix = ?', input.prefix).toArray()[0];
  // Same cost whether the prefix exists or not: the hash is always computed.
  const hash = await secretHash(input.secret);
  if (!row || !timingSafeEqual(new Uint8Array(row.hash), hash)) return invalidKey();
  if (row.revoked_at !== null) return invalidKey('api_key_revoked');
  if (deps.info().shopState === 'uninstalled') return problem(403, 'forbidden', 'shop_not_installed');

  const rate = deps.limiter.take(row.prefix, now);
  const rateHeaders = rateLimitHeaders(rate);
  const withRate = (r: ApiResult): ApiResult => ({ ...r, headers: { ...r.headers, ...rateHeaders } });
  if (!rate.allowed) return withRate(problem(429, 'rate_limited', `limit of ${rate.limit} requests (burst) and 20 requests per second per key`, undefined, { 'Retry-After': String(rate.retryAfterSeconds) }));

  const matched = matchPublicRoute(input.call.method, input.call.path);
  if (!matched) return withRate(problem(404, 'not_found', `no route ${input.call.method} ${input.call.path}`));
  if ('allowed' in matched) return withRate(problem(405, 'validation_failed', `method not allowed (allowed: ${matched.allowed.join(', ')})`, undefined, { Allow: matched.allowed.join(', ') }));
  const { route, params } = matched;

  const scopes = parseScopes(row.scopes);
  const required = requiredScope(d, route, params, input.call.body);
  if (!scopes.includes(required)) {
    return withRate(problem(403, 'forbidden', `insufficient_scope: ${required} required`, undefined, { 'WWW-Authenticate': `Bearer realm="serialis", error="insufficient_scope", scope="${required}"` }));
  }

  if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_RESOLUTION_MS) {
    d.sql.exec('UPDATE api_keys SET last_used_at = ? WHERE prefix = ?', now, row.prefix);
  }

  const principal: Principal = {
    surface: 'public',
    actor: { type: 'api_key', id: row.prefix },
    // 11.2 `api_idempotency.key` = Idempotency-Key + prefix of the API key.
    idempotencyScope: `key:${row.prefix}`,
    scopes,
  };
  const call: ApiCall = { ...input.call, principal };
  const result = route.name === 'createUnit' ? await createUnit(d, call, deps.info) : await handleApiCall(d, call, deps.info);
  return withRate(result);
}

function parseScopes(raw: string): ApiScope[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((s): s is ApiScope => API_SCOPES.includes(s as ApiScope)) : [];
  } catch {
    return [];
  }
}

/** 14.1: a resolution that writes the Shopify stock requires `admin` instead of `anomalies:write`. */
function requiredScope(d: DomainContext, route: CompiledPublicRoute, params: Record<string, string>, body: string | null): ApiScope {
  if (route.name !== 'resolveAnomaly') return route.scope;
  let action: unknown;
  try {
    action = body ? (JSON.parse(body) as { action?: unknown }).action : undefined;
  } catch {
    return route.scope;
  }
  const type = d.sql.exec<{ type: string }>('SELECT type FROM anomalies WHERE id = ?', params.id ?? '').toArray()[0]?.type;
  if (!type || typeof action !== 'string') return route.scope;
  return anomalyActions(type, 'en').some((a) => a.action === action && a.writesStock) ? 'admin' : route.scope;
}

/**
 * `POST /units` (14.2, 19.4): one unit, run as `POST /units/batch` in atomic mode (same checks,
 * same idempotency store), answered with the created `Unit` and its ETag.
 */
async function createUnit(d: DomainContext, call: ApiCall, info: () => ShopInfo): Promise<ApiResult> {
  let body: Partial<CreateUnitRequest>;
  try {
    body = JSON.parse(call.body ?? '') as Partial<CreateUnitRequest>;
  } catch {
    return problem(400, 'validation_failed', 'invalid JSON body');
  }
  if (!body || typeof body !== 'object' || typeof body.ref !== 'string') return problem(400, 'validation_failed', 'ref (string) required', [{ field: 'ref', code: 'validation_failed' }]);
  const batch: CreateUnitsBatchRequest = {
    variantGid: body.variantGid as string,
    locationId: body.locationId as string,
    refs: [body.ref],
    alreadyCounted: body.alreadyCounted === true,
    mode: 'atomic',
  };
  const result = await handleApiCall(d, { ...call, path: '/units/batch', body: JSON.stringify(batch) }, info);
  if (result.status !== 201 || !result.body) return result;
  const unit = (JSON.parse(result.body) as CreateUnitsBatchResponse).created[0];
  if (!unit) return problem(422, 'validation_failed', 'unit not created');
  const replayed = result.headers['Idempotent-Replayed'];
  return json(unit, 201, { ETag: unitEtag(unit.version), ...(replayed ? { 'Idempotent-Replayed': replayed } : {}) });
}

// ------------------------------------------------------------------------------------------ key management

export function isApiKeysPath(path: string): boolean {
  return path === '/api-keys' || path.startsWith('/api-keys/');
}

function presentKey(row: ApiKeyRow, shop: string): ApiKey {
  return {
    prefix: row.prefix,
    name: row.name,
    scopes: parseScopes(row.scopes),
    hint: keyHint(row.seal_version, row.location, shop, row.prefix),
    createdAt: iso(row.created_at)!,
    createdBy: row.created_by,
    lastUsedAt: iso(row.last_used_at),
    revokedAt: iso(row.revoked_at),
  };
}

/**
 * `GET /api-keys`, `POST /api-keys`, `DELETE /api-keys/{prefix}` (internal surface). The creation
 * response is not kept in `api_idempotency`: it carries the secret, which is never stored in clear.
 */
export async function handleApiKeysCall(d: DomainContext, env: Env, call: ApiCall): Promise<ApiResult> {
  // O5: API keys are managed from the interface only (administrators, 15.8), never with an API key.
  if (call.principal.surface !== 'internal' || call.principal.scopes !== 'all') return problem(403, 'forbidden', 'api_keys_interface_only');
  const now = Date.now();
  const shop = d.shopDomain;
  const sub = call.path.slice('/api-keys'.length);

  if (sub === '' || sub === '/') {
    if (call.method === 'GET') {
      const rows = d.sql.exec<ApiKeyRow>('SELECT * FROM api_keys ORDER BY created_at DESC, prefix').toArray();
      return json({ items: rows.map((r) => presentKey(r, shop)), nextCursor: null });
    }
    if (call.method === 'POST') return createKey(d, env, call, now);
    return problem(405, 'validation_failed', 'method not allowed (allowed: GET, POST)', undefined, { Allow: 'GET, POST' });
  }

  const prefix = safeDecode(sub.slice(1));
  if (prefix.includes('/')) return problem(404, 'not_found', `no route ${call.method} ${call.path}`);
  if (call.method !== 'DELETE') return problem(405, 'validation_failed', 'method not allowed (allowed: DELETE)', undefined, { Allow: 'DELETE' });
  const row = d.sql.exec<ApiKeyRow>('SELECT * FROM api_keys WHERE prefix = ?', prefix).toArray()[0];
  if (!row) return problem(404, 'not_found', 'unknown api key');
  if (row.revoked_at === null) {
    // Immediate: no cache of keys exists outside this object (14.1).
    d.storage.transactionSync(() => {
      d.sql.exec('UPDATE api_keys SET revoked_at = ? WHERE prefix = ?', now, prefix);
      d.repo.audit(call.principal.actor, 'api_key.revoke', { prefix, name: row.name }, { prefix, revokedAt: now }, now);
    });
    logEvent('info', 'api_key.revoked', { shop, prefix });
  }
  return noContent();
}

async function createKey(d: DomainContext, env: Env, call: ApiCall, now: number): Promise<ApiResult> {
  let body: Partial<CreateApiKeyRequest>;
  try {
    body = JSON.parse(call.body ?? '') as Partial<CreateApiKeyRequest>;
  } catch {
    return problem(400, 'validation_failed', 'invalid JSON body');
  }
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > 100) return problem(422, 'validation_failed', 'name must have 1 to 100 characters', [{ field: 'name', code: 'validation_failed' }]);
  const scopes = Array.isArray(body.scopes) ? [...new Set(body.scopes)] : [];
  if (scopes.length === 0 || scopes.some((s) => !API_SCOPES.includes(s))) {
    return problem(422, 'validation_failed', `scopes must be a non-empty list of ${API_SCOPES.join(', ')}`, [{ field: 'scopes', code: 'validation_failed' }]);
  }
  const active = Number(d.sql.exec('SELECT count(*) AS n FROM api_keys WHERE revoked_at IS NULL').one().n);
  if (active >= MAX_ACTIVE_KEYS) return problem(422, 'validation_failed', `at most ${MAX_ACTIVE_KEYS} active keys per shop`);
  if (currentSealVersion(env) === null) return problem(503, 'rate_limited', 'api_key_sealing_not_configured', undefined, { 'Retry-After': '60' });

  const location: KeyLocation = (d.repo.meta('object_name') ?? '').startsWith('eu:') ? 'eu' : 'global';
  let issued;
  try {
    issued = await issueApiKey(env, d.shopDomain, location);
  } catch (error) {
    logEvent('error', 'api_key.issue_failed', { shop: d.shopDomain, error: errorMessage(error) });
    return problem(503, 'rate_limited', 'api_key_sealing_not_configured', undefined, { 'Retry-After': '60' });
  }
  const ordered = API_SCOPES.filter((s) => scopes.includes(s));
  const createdBy = call.principal.actor.id;
  d.storage.transactionSync(() => {
    d.sql.exec(
      'INSERT INTO api_keys (prefix, name, hash, scopes, seal_version, location, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      issued.prefix,
      name,
      issued.hash.buffer.slice(issued.hash.byteOffset, issued.hash.byteOffset + issued.hash.byteLength) as ArrayBuffer,
      JSON.stringify(ordered),
      issued.version,
      location,
      createdBy,
      now,
    );
    d.repo.audit(call.principal.actor, 'api_key.create', null, { prefix: issued.prefix, name, scopes: ordered }, now);
  });
  logEvent('info', 'api_key.created', { shop: d.shopDomain, prefix: issued.prefix });
  const row = d.sql.exec<ApiKeyRow>('SELECT * FROM api_keys WHERE prefix = ?', issued.prefix).one();
  const response: CreateApiKeyResponse = { apiKey: presentKey(row, d.shopDomain), key: issued.key };
  return json(response, 201);
}
