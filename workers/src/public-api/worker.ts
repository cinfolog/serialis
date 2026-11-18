/**
 * Public API entry in the Worker (spec 14.1, 11.3, 16).
 *
 * Routing rule (workers/DECISIONS.md):
 *  - a host whose name starts with `api.` (production: `api.serialis.dev`) serves the public API
 *    under `/v1` and nothing else (apart from `/healthz`);
 *  - every other host serves it under `/public/v1`, except in production, where the app host does
 *    not expose it (one public entry point, behind the WAF and rate limiting rules of `api.`).
 *
 * Order of checks: API key syntax, seal (constant time) — an invented key is refused here, before
 * any KV read or object call —, shop status in KV (confirmed by D1 when not active, 10.5), then the
 * call is handed to the object named by the key's public part, which checks the secret, the scopes
 * and the rate limit.
 */
import { PUBLIC_BASE, PUBLIC_PATH_BASE } from '@serialis/contract';
import { openApiDocument } from '@serialis/contract/openapi';
import type { Env } from '../env.js';
import { errorMessage, logEvent } from '../log.js';
import { objectNameFor, resolveRouting, shopStub } from '../routing.js';
import { problem, toResponse, type ApiResult } from '../api/http.js';
import { parseApiKey, verifySeal } from './keys.js';
import { invalidKey } from './object.js';

/** Base path of the public API for this request, or null when the request is not for it. */
export function publicApiBase(url: URL, env: Pick<Env, 'ENVIRONMENT'>): string | null {
  if (isApiHost(url)) return PUBLIC_BASE;
  if (env.ENVIRONMENT === 'production') return null;
  return url.pathname === PUBLIC_PATH_BASE || url.pathname.startsWith(`${PUBLIC_PATH_BASE}/`) ? PUBLIC_PATH_BASE : null;
}

export function isApiHost(url: URL): boolean {
  return url.hostname.startsWith('api.');
}

function respond(result: ApiResult): Response {
  return toResponse(result);
}

export async function handlePublicApi(request: Request, env: Env, url: URL, base: string): Promise<Response> {
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return respond(problem(404, 'not_found', 'see /v1/openapi.json'));
  const path = url.pathname.slice(base.length) || '/';

  // Published description of the surface (14.1), no authentication.
  if ((request.method === 'GET' || request.method === 'HEAD') && path === '/openapi.json') {
    const doc = { ...openApiDocument, servers: [{ url: `${url.origin}${base}` }] };
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(doc), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const auth = request.headers.get('Authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) return respond(invalidKey('api_key_required'));
  const key = parseApiKey(m[1]);
  // T-SEC-01 / T-SEC-02: a malformed key or a wrong seal never reaches KV, D1 or an object.
  if (!key || !(await verifySeal(env, key))) {
    logEvent('warn', 'public_api.bad_key', { reason: key ? 'seal' : 'format' });
    return respond(invalidKey());
  }

  // A request naming another shop than the key's is refused (T-SEC-01).
  const requestedShop = url.searchParams.get('shop');
  if (requestedShop !== null && requestedShop !== key.shop) return respond(problem(403, 'forbidden', 'shop_mismatch'));

  try {
    // 10.5: the Worker refuses the key of an uninstalled shop from the KV status (absent or not
    // active is confirmed by D1). The object itself comes from the key, not from the registry.
    const routing = await resolveRouting(env, key.shop);
    if (!routing) return respond(invalidKey());
    if (routing.status === 'inactive') return respond(problem(403, 'forbidden', 'shop_not_installed'));
    const jurisdiction = key.location === 'eu' ? 'eu' : null;
    const stub = shopStub(env, { objectName: objectNameFor(key.shop, jurisdiction), jurisdiction, locationHint: null });

    const query: Record<string, string[]> = {};
    for (const name of new Set(url.searchParams.keys())) if (name !== 'shop') query[name] = url.searchParams.getAll(name);
    const result = await stub.publicApi({
      shop: key.shop,
      prefix: key.prefix,
      secret: key.secret,
      call: {
        method: request.method,
        path,
        query,
        headers: {
          idempotencyKey: request.headers.get('Idempotency-Key'),
          ifMatch: request.headers.get('If-Match'),
          contentType: request.headers.get('Content-Type'),
          acceptLanguage: request.headers.get('Accept-Language'),
        },
        body: request.method === 'GET' || request.method === 'HEAD' ? null : await request.text(),
      },
    });
    return respond(result);
  } catch (error) {
    logEvent('error', 'public_api.unavailable', { shop: key.shop, path, error: errorMessage(error) });
    return respond(problem(503, 'rate_limited', 'service temporarily unavailable', undefined, { 'Retry-After': '5' }));
  }
}
