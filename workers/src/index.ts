import { SessionTokenError, ShopifyError, ShopifyOAuthError, sessionTokenFromRequest, verifySessionToken } from '@serialis/shopify';
import type { Env } from './env.js';
import { isValidShopDomain, verifyShopifyWebhook } from './hmac.js';
import { installFromSessionToken } from './install.js';
import { errorMessage, logEvent } from './log.js';
import { markUninstalled, resolveRouting, shopStub } from './routing.js';
import { isComplianceTopic } from './topics.js';
import { API_PREFIX, handleInternalApi } from './api/internal.js';
import { serveAdminApp } from './assets.js';
import { handlePublicApi, publicApiBase } from './public-api/worker.js';

export { ShopStore } from './shop-store.js';

/**
 * Main Worker `serialis-web` (spec 10.2). Routes:
 *  - api.* host (/v1/*) and /public/v1/* (not in production): public API, API keys (public-api/worker.ts)
 *  - /api/v1/*   internal API (api/contract), session or ID token, CORS for the admin extensions
 *  - GET /api/me session-token authentication, installation, shop status (lot 0)
 *  - POST /webhooks/shopify — signature check, routing, idempotent storage in the shop's object
 *  - GET /healthz
 *  - anything else: the embedded admin app (`app/dist` through the `ASSETS` binding)
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Public API (14.1): `api.*` host under /v1, `/public/v1` on the staging and pilot hosts.
    const publicBase = publicApiBase(url, env);
    if (publicBase !== null && !(request.method === 'GET' && url.pathname === '/healthz')) return handlePublicApi(request, env, url, publicBase);
    // Production: the app host does not expose the public API (single entry point `api.`).
    if (url.pathname.startsWith('/public/')) return new Response('Not found', { status: 404 });

    if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
      return handleInternalApi(request, env, url);
    }

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return Response.json({ ok: true, environment: env.ENVIRONMENT });
    }

    if (request.method === 'GET' && url.pathname === '/api/me') {
      return handleMe(request, env, url);
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/shopify') {
      return handleWebhook(request, env);
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      return serveAdminApp(request, env, url);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/** `GET /api/me`: verifies the session token, installs or reactivates the shop if needed, returns its status. */
async function handleMe(request: Request, env: Env, url: URL): Promise<Response> {
  let session;
  try {
    session = await verifySessionToken(sessionTokenFromRequest(request), {
      apiKey: env.SHOPIFY_API_KEY,
      apiSecret: env.SHOPIFY_API_SECRET,
      expectedShop: url.searchParams.get('shop'),
    });
  } catch (error) {
    if (error instanceof SessionTokenError) return invalidSession(error.reason);
    throw error;
  }

  try {
    const { install } = await installFromSessionToken(env, session);
    return Response.json(
      {
        shop: session.shop,
        installed: true,
        status: install.shopState,
        installCount: install.installCount,
        installedAt: new Date(install.installedAt).toISOString(),
        token: install.token,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof ShopifyOAuthError && error.kind === 'invalid_subject_token') return invalidSession('rejected_by_shopify');
    logEvent('error', 'api_me.failed', { shop: session.shop, error: errorMessage(error) });
    const upstream = error instanceof ShopifyOAuthError || error instanceof ShopifyError;
    return Response.json({ error: upstream ? 'shopify_unavailable' : 'internal_error' }, { status: upstream ? 502 : 500 });
  }
}

/** 401 with the header App Bridge uses to fetch a fresh session token and retry once. */
function invalidSession(reason: string): Response {
  return Response.json(
    { error: 'invalid_session_token', reason },
    { status: 401, headers: { 'X-Shopify-Retry-Invalid-Session-Request': '1', 'Cache-Control': 'no-store' } },
  );
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const raw = await request.arrayBuffer();
  const valid = await verifyShopifyWebhook(raw, request.headers.get('X-Shopify-Hmac-Sha256'), env.SHOPIFY_API_SECRET);
  // Rejected before waking any object (T-SEC-01).
  if (!valid) return new Response('Unauthorized', { status: 401 });

  const shop = request.headers.get('X-Shopify-Shop-Domain');
  const topic = request.headers.get('X-Shopify-Topic');
  const webhookId = request.headers.get('X-Shopify-Webhook-Id');
  if (!isValidShopDomain(shop) || !topic || !webhookId) return new Response('Bad request', { status: 400 });

  try {
    const routing = await resolveRouting(env, shop);
    // Unknown or uninstalled shop: acknowledged and ignored, except the compliance topics (spec 10.5).
    if (!routing) return Response.json({ stored: false, reason: 'unknown_shop' });
    if (routing.status === 'inactive' && !isComplianceTopic(topic)) return Response.json({ stored: false, reason: 'inactive' });

    const result = await shopStub(env, routing).ingest({
      webhookId,
      topic,
      triggeredAt: request.headers.get('X-Shopify-Triggered-At'),
      payload: new TextDecoder().decode(raw),
    });
    if (topic === 'app/uninstalled' && 'shopState' in result && result.shopState === 'uninstalled') {
      await markUninstalled(env, shop);
    }
    // 200 for duplicates too: Shopify must stop retrying.
    return Response.json(result, { status: 200 });
  } catch (error) {
    // Not stored: 5xx so that Shopify retries (spec 12.1 step 3).
    logEvent('error', 'webhook.failed', { shop, topic, error: errorMessage(error) });
    return new Response('Retry later', { status: 503 });
  }
}
