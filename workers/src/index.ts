import { SessionTokenError, ShopifyError, ShopifyOAuthError, sessionTokenFromRequest, verifySessionToken } from '@serialis/shopify';
import type { Env } from './env.js';
import { isValidShopDomain, verifyShopifyWebhook } from './hmac.js';
import { installFromSessionToken } from './install.js';
import { errorMessage, logEvent } from './log.js';
import { markUninstalled, resolveRouting, shopStub } from './routing.js';
import { isComplianceTopic } from './topics.js';

export { ShopStore } from './shop-store.js';

/**
 * Main Worker `serialis-web` (spec 10.2). Routes:
 *  - GET  /            embedded app shell (App Bridge)
 *  - GET  /healthz
 *  - GET  /api/me      session-token authentication, installation, shop status
 *  - POST /webhooks/shopify — signature check, routing, idempotent storage in the shop's object.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return appShell(env);
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

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Embedded app entry (placeholder until the React Router app, spec 10.2): loads App Bridge, which adds
 * the session token to `fetch` calls, and shows the installation status from `/api/me`.
 */
function appShell(env: Env): Response {
  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="shopify-api-key" content="${env.SHOPIFY_API_KEY}">
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<title>Serialis</title>
</head>
<body style="font-family: system-ui, sans-serif; padding: 24px">
<h1 style="font-size: 20px">Serialis</h1>
<p id="status">Connexion à la boutique… / Connecting to the shop…</p>
<script>
fetch('/api/me').then(function (r) { return r.json(); }).then(function (me) {
  document.getElementById('status').textContent = me.shop
    ? 'Boutique / Shop : ' + me.shop + ' (' + me.status + ', ' + me.token + ')'
    : 'Session refusée / Session refused';
}).catch(function () {
  document.getElementById('status').textContent = 'Service indisponible / Service unavailable';
});
</script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The admin frames the app: allow Shopify domains only.
      'Content-Security-Policy': 'frame-ancestors https://*.myshopify.com https://admin.shopify.com',
    },
  });
}

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
