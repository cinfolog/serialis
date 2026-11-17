import type { Env } from './env.js';
import { isValidShopDomain, verifyShopifyWebhook } from './hmac.js';

export { ShopStore } from './shop-store.js';

/**
 * Main Worker `serialis-web` (spec 10.2). Lot 0 routes:
 *  - GET  /healthz
 *  - POST /webhooks/shopify — signature check, then idempotent storage in the shop's object.
 * Admin app, extension endpoints and public API come next.
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

    if (request.method === 'POST' && url.pathname === '/webhooks/shopify') {
      return handleWebhook(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Embedded app entry (lot 0 placeholder): loads App Bridge so the app opens inside the Shopify admin.
 * Session-token authentication and the real home screen (15.4) come with the installation flow.
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
<p>Installation en cours de construction (${env.ENVIRONMENT}).</p>
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

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const raw = await request.arrayBuffer();
  const valid = await verifyShopifyWebhook(raw, request.headers.get('X-Shopify-Hmac-Sha256'), env.SHOPIFY_API_SECRET);
  // Rejected before waking any object (T-SEC-01).
  if (!valid) return new Response('Unauthorized', { status: 401 });

  const shop = request.headers.get('X-Shopify-Shop-Domain');
  const topic = request.headers.get('X-Shopify-Topic');
  const webhookId = request.headers.get('X-Shopify-Webhook-Id');
  if (!isValidShopDomain(shop) || !topic || !webhookId) return new Response('Bad request', { status: 400 });

  // TODO lot 0: resolve the object through KV `shop-routing` / D1 registry (jurisdiction eu or location hint, spec 10.5).
  const stub = env.SHOP_STORE.get(env.SHOP_STORE.idFromName(shop));
  const result = await stub.ingest({
    webhookId,
    topic,
    triggeredAt: request.headers.get('X-Shopify-Triggered-At'),
    payload: new TextDecoder().decode(raw),
  });

  // 200 for duplicates too: Shopify must stop retrying.
  return Response.json(result, { status: 200 });
}
