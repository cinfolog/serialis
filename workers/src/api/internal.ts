/**
 * Internal surface `/api/v1/*` (api/contract): authentication by the App Bridge session token of
 * the embedded app or the OpenID Connect ID token of the admin UI extensions (both HS256 JWTs
 * signed with the app secret, `aud` = client id, `dest` = shop), CORS for the extensions, then
 * the call is handed to the shop's object. The public API (api.serialis.dev/v1, API keys) will
 * reuse `ShopStore.api` with its own authentication layer.
 */
import { EXTENSION_HEADER } from '@serialis/contract';
import { SessionTokenError, ShopifyOAuthError, sessionTokenFromRequest, verifySessionToken, type SessionToken } from '@serialis/shopify';
import type { Env } from '../env.js';
import { installFromSessionToken } from '../install.js';
import { errorMessage, logEvent } from '../log.js';
import { resolveRouting, shopStub } from '../routing.js';
import { problem, toResponse, type ApiCall } from './http.js';

export const API_PREFIX = '/api/v1';

/** Origins allowed to call the API from a browser: admin UI extensions are served from Shopify's CDN. */
const EXTENSION_ORIGINS = new Set(['https://extensions.shopifycdn.com']);

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!origin || !EXTENSION_ORIGINS.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': `Authorization, Content-Type, Idempotency-Key, If-Match, If-None-Match, Accept, ${EXTENSION_HEADER}`,
    'Access-Control-Expose-Headers': 'ETag, Idempotent-Replayed, Retry-After, X-Shopify-Retry-Invalid-Session-Request',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function invalidSession(reason: string, cors: Record<string, string>): Response {
  return toResponse(problem(401, 'unauthenticated', reason), { 'X-Shopify-Retry-Invalid-Session-Request': '1', ...cors });
}

export async function handleInternalApi(request: Request, env: Env, url: URL): Promise<Response> {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Cache-Control': 'no-store' } });

  let session: SessionToken;
  try {
    session = await verifySessionToken(sessionTokenFromRequest(request), {
      apiKey: env.SHOPIFY_API_KEY,
      apiSecret: env.SHOPIFY_API_SECRET,
      expectedShop: url.searchParams.get('shop'),
    });
  } catch (error) {
    if (error instanceof SessionTokenError) {
      // T-SEC-01: a request for another shop than the authenticated one is refused with 403.
      if (error.reason === 'shop_mismatch') return toResponse(problem(403, 'forbidden', 'shop_mismatch'), cors);
      return invalidSession(error.reason, cors);
    }
    throw error;
  }

  const path = url.pathname.slice(API_PREFIX.length) || '/';
  try {
    let routing = await resolveRouting(env, session.shop);
    if (path === '/me' && request.method === 'GET' && (!routing || routing.status !== 'active')) {
      // First opening (or reinstallation): installation from the session token (9.14).
      routing = (await installFromSessionToken(env, session)).routing;
    }
    if (!routing || routing.status === 'inactive') return toResponse(problem(403, 'forbidden', 'shop_not_installed'), cors);

    const query: Record<string, string[]> = {};
    for (const key of new Set(url.searchParams.keys())) query[key] = url.searchParams.getAll(key);
    const call: ApiCall = {
      method: request.method,
      path,
      query,
      headers: {
        idempotencyKey: request.headers.get('Idempotency-Key'),
        ifMatch: request.headers.get('If-Match'),
        ifNoneMatch: request.headers.get('If-None-Match'),
        contentType: request.headers.get('Content-Type'),
        acceptLanguage: request.headers.get('Accept-Language'),
        extension: request.headers.get(EXTENSION_HEADER),
      },
      body: request.method === 'GET' || request.method === 'HEAD' ? null : await request.text(),
      principal: {
        surface: 'internal',
        actor: { type: 'user', id: session.userId },
        idempotencyScope: `internal:${session.userId ?? 'extension'}`,
        scopes: 'all',
      },
    };
    const result = await shopStub(env, routing).api(call);
    return toResponse(result, cors);
  } catch (error) {
    if (error instanceof SessionTokenError) return invalidSession(error.reason, cors);
    if (error instanceof ShopifyOAuthError && error.kind === 'invalid_subject_token') return invalidSession('rejected_by_shopify', cors);
    logEvent('error', 'api.unavailable', { shop: session.shop, path, error: errorMessage(error) });
    return toResponse(problem(503, 'rate_limited', 'service temporarily unavailable', undefined, { 'Retry-After': '5' }), cors);
  }
}
