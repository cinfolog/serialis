/**
 * Route table of the API (contract `ALL_ROUTES`, spec 14.2) and the rules shared by both surfaces
 * (14.1): `Idempotency-Key` on every POST, stored 24 h, replayed when the body is the same and
 * refused (409) otherwise; problem+json errors. Runs inside the shop object; the caller has
 * authenticated the request and chosen the object.
 */
import { ALL_ROUTES, OPERATIONS_ROUTES } from '@serialis/contract';
import type { DomainContext } from '../domain/context.js';
import { sha256Hex } from '../domain/util.js';
import { errorMessage, logEvent } from '../log.js';
import * as admin from './admin.js';
import { ApiError, json, locale, problem, queryOne, type ApiCall, type ApiResult } from './http.js';
import * as orders from './orders.js';
import type { ApiContext } from './present.js';
import * as units from './units.js';
import * as users from './users.js';
import * as health from './health.js';

/** Routes served by the shop object: contract tables of the admin app and of the operations (15.8, 17). */
export const SERVED_ROUTES = { ...ALL_ROUTES, ...OPERATIONS_ROUTES } as const;
export type AnyRouteName = keyof typeof SERVED_ROUTES;

/** Administration level (15.8): settings, tracked items, imports confirmation, emergency stop, users, health. */
const ADMIN_ROUTES: ReadonlySet<AnyRouteName> = new Set<AnyRouteName>([
  'patchSettings',
  'simulateSettings',
  'trackItems',
  'confirmImport',
  'pause',
  'resume',
  'listAppUsers',
  'patchAppUser',
  'health',
  'reviveTask',
  'retryWrite',
  'abandonWrite',
]);

export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

type Handler = (ctx: ApiContext, params: Record<string, string>) => ApiResult | Promise<ApiResult>;

export interface ShopInfo {
  shop: string;
  tokenStatus: string;
  shopState: string | null;
}

function handlers(info: () => ShopInfo): Record<AnyRouteName, Handler> {
  return {
    me: (ctx) => admin.me(ctx, info()),
    listAppUsers: (ctx) => users.listAppUsers(ctx),
    patchAppUser: (ctx) => users.patchAppUser(ctx),
    health: (ctx) => health.healthReport(ctx, info()),
    reviveTask: (ctx, p) => health.reviveTask(ctx, info(), p.key!),
    retryWrite: (ctx, p) => health.retryWrite(ctx, info(), p.id!),
    abandonWrite: (ctx, p) => health.abandonWrite(ctx, info(), p.id!),
    homeStats: (ctx) => admin.homeStats(ctx, info()),
    listTrackedItems: (ctx) => units.listTrackedItems(ctx),
    trackItems: (ctx) => units.trackItems(ctx),
    listUnits: (ctx) => units.listUnits(ctx),
    getUnit: (ctx, p) => units.getUnit(ctx, p.id!),
    createUnitsBatch: (ctx) => units.createUnitsBatch(ctx),
    checkUnitsBatch: (ctx) => units.checkUnitsBatch(ctx),
    lookup: (ctx) => units.lookup(ctx),
    unitEvents: (ctx, p) => units.unitEvents(ctx, p.id!),
    orderAllocations: (ctx, p) => orders.orderAllocations(ctx, p.orderId!),
    createAllocation: (ctx) => orders.createAllocation(ctx),
    deleteAllocation: (ctx, p) => orders.deleteAllocation(ctx, p.id!),
    replaceAllocation: (ctx, p) => orders.replaceAllocation(ctx, p.id!),
    confirmShipped: (ctx, p) => orders.confirmShipped(ctx, p.id!),
    identifyReturn: (ctx, p) => orders.identifyReturn(ctx, p.returnId!),
    listAnomalies: (ctx) => orders.listAnomalies(ctx),
    acknowledgeAnomaly: (ctx, p) => orders.acknowledgeAnomaly(ctx, p.id!),
    resolveAnomaly: (ctx, p) => orders.resolveAnomaly(ctx, p.id!),
    listLocations: (ctx) => admin.listLocations(ctx),
    getSettings: (ctx) => admin.getSettings(ctx),
    simulateSettings: (ctx) => admin.simulateSettings(ctx),
    patchSettings: (ctx) => admin.patchSettings(ctx),
    createImport: (ctx) => units.createImport(ctx),
    getImport: (ctx, p) => units.getImport(ctx, p.id!),
    confirmImport: (ctx, p) => units.confirmImport(ctx, p.id!),
    pause: (ctx) => admin.setAutomation(ctx, true),
    resume: (ctx) => admin.setAutomation(ctx, false),
  };
}

interface CompiledRoute {
  name: AnyRouteName;
  method: string;
  regex: RegExp;
  params: string[];
}

/** Static segments win over parameters (`/units/batch` before `/units/{id}`). */
const COMPILED: CompiledRoute[] = (Object.entries(SERVED_ROUTES) as Array<[AnyRouteName, string]>)
  .map(([name, spec]) => {
    const [method, path] = spec.split(' ') as [string, string];
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
    return { name, method, regex, params };
  })
  .sort((a, b) => a.params.length - b.params.length);

export function matchRoute(method: string, path: string): { route: CompiledRoute; params: Record<string, string> } | { allowed: string[] } | null {
  const allowed: string[] = [];
  for (const route of COMPILED) {
    const m = route.regex.exec(path);
    if (!m) continue;
    if (route.method !== method) {
      allowed.push(route.method);
      continue;
    }
    const params: Record<string, string> = {};
    route.params.forEach((p, i) => (params[p] = decodeURIComponent(m[i + 1]!)));
    return { route, params };
  }
  return allowed.length > 0 ? { allowed } : null;
}

/** First render of an admin extension (15.4 "Démarrage", T-UX-08), recognised by the calls each block makes. */
function extensionHint(call: ApiCall, name: AnyRouteName): string | null {
  if (name === 'listTrackedItems' && queryOne(call, 'variant')) return 'variant_block';
  if (name === 'listTrackedItems' && queryOne(call, 'product')) return 'product_block';
  if (name === 'orderAllocations') return 'order_block';
  if (name === 'replaceAllocation' || name === 'deleteAllocation' || name === 'createAllocation') return 'order_action';
  return null;
}

export async function handleApiCall(d: DomainContext, call: ApiCall, info: () => ShopInfo): Promise<ApiResult> {
  const matched = matchRoute(call.method, call.path);
  if (!matched) return problem(404, 'not_found', `no route ${call.method} ${call.path}`);
  if ('allowed' in matched) return problem(405, 'validation_failed', `method not allowed (allowed: ${matched.allowed.join(', ')})`, undefined, { Allow: matched.allowed.join(', ') });
  const { route, params } = matched;
  const now = Date.now();

  users.registerAppUser(d, call.principal, now);
  // 15.8: checked before the idempotency store, so that a refusal is never replayed after a promotion.
  if (ADMIN_ROUTES.has(route.name) && users.roleOf(d, call.principal) !== 'admin') return problem(403, 'forbidden', 'admin_required');

  const hint = extensionHint(call, route.name);
  if (hint && d.repo.meta(`extension_render:${hint}`) === null) d.repo.setMeta(`extension_render:${hint}`, String(now));

  let storeKey: string | null = null;
  let requestHash = '';
  if (call.method === 'POST') {
    const key = call.headers.idempotencyKey?.trim();
    if (!key || key.length > 255) return problem(400, 'validation_failed', 'Idempotency-Key header required on POST (1 to 255 characters)');
    storeKey = `${call.principal.idempotencyScope}:${key}`;
    requestHash = sha256Hex(`${call.method} ${call.path}\n${call.body ?? ''}`);
    const stored = d.sql
      .exec<{ request_hash: string; status_code: number; response: string; headers: string; expires_at: number }>('SELECT * FROM api_idempotency WHERE key = ?', storeKey)
      .toArray()[0];
    if (stored && stored.expires_at > now) {
      if (stored.request_hash !== requestHash) return problem(409, 'idempotency_conflict', 'this Idempotency-Key was used with another request');
      return { status: stored.status_code, headers: { ...(JSON.parse(stored.headers) as Record<string, string>), 'Idempotent-Replayed': 'true' }, body: stored.response || null };
    }
  }

  const ctx: ApiContext = { d, call, now, cause: { type: call.principal.surface === 'public' ? 'api_request' : 'ui_action', id: null }, locale: locale(call) };
  let result: ApiResult;
  try {
    result = await handlers(info)[route.name](ctx, params);
  } catch (error) {
    if (error instanceof ApiError) result = problem(error.status, error.code, error.detail, error.errors, error.headers);
    else {
      logEvent('error', 'api.failed', { route: route.name, error: errorMessage(error) });
      const upstream = error instanceof Error && (error.name === 'ShopifyError' || error.name === 'ReconnectRequiredError');
      return upstream ? problem(502, 'rate_limited', 'Shopify unavailable, retry later', undefined, { 'Retry-After': '5' }) : json({ error: 'internal_error' }, 500);
    }
  }
  if (storeKey && result.status < 500) {
    d.sql.exec(
      'INSERT INTO api_idempotency (key, request_hash, status_code, response, headers, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET request_hash = excluded.request_hash, status_code = excluded.status_code, response = excluded.response, headers = excluded.headers, expires_at = excluded.expires_at',
      storeKey,
      requestHash,
      result.status,
      result.body ?? '',
      JSON.stringify(result.headers),
      now + IDEMPOTENCY_TTL_MS,
    );
  }
  return result;
}
