import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { objectNameFor } from '../src/routing.js';
import type { ShopStore } from '../src/shop-store.js';
import { installShop, sendWebhook } from './helpers.js';

const SHOP = 'example.myshopify.com';

function post(body: string, hmac: string, webhookId = 'wh-1', shop = SHOP) {
  return SELF.fetch('https://hooks.serialis.dev/webhooks/shopify', {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': hmac,
      'X-Shopify-Shop-Domain': shop,
      'X-Shopify-Topic': 'orders/create',
      'X-Shopify-Webhook-Id': webhookId,
    },
  });
}

describe('webhook reception (lot 0 exit criterion)', () => {
  it('rejects a bad signature with 401', async () => {
    const res = await post('{"id":1}', 'bm9wZQ==');
    expect(res.status).toBe(401);
  });

  it('stores a signed webhook once, ignores the retry', async () => {
    const { stub } = await installShop(SHOP);
    const body = { id: 1042 };
    const first = await sendWebhook({ shop: SHOP, topic: 'orders/create', body, webhookId: 'wh-42' });
    expect(await first.json()).toEqual({ stored: true, action: 'task', shopState: 'active' });
    const retry = await sendWebhook({ shop: SHOP, topic: 'orders/create', body, webhookId: 'wh-42' });
    expect(await retry.json()).toEqual({ stored: false, reason: 'duplicate', shopState: 'active' });

    expect(await stub.inboxCount()).toBe(1);
    expect(await stub.schemaVersion()).toBe(7);
  });

  it('acknowledges and ignores a webhook for an unknown shop without creating its database', async () => {
    const shop = 'unknown-example.myshopify.com';
    const res = await sendWebhook({ shop, topic: 'orders/create', body: { id: 1 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: false, reason: 'unknown_shop' });
    const stub = env.SHOP_STORE.get(env.SHOP_STORE.idFromName(objectNameFor(shop, null)));
    expect(await stub.schemaVersion()).toBe(0);
  });

  it('refuses calls to an object that was never installed', async () => {
    const stub = env.SHOP_STORE.get(env.SHOP_STORE.idFromName('global:never-example.myshopify.com'));
    expect(await stub.ingest({ webhookId: 'w', topic: 'orders/create', triggeredAt: null, payload: '{}' })).toEqual({ stored: false, reason: 'not_installed' });
    await runInDurableObject(stub, (store: ShopStore) => {
      expect(() => store.reviveTask('k')).toThrow(/shop_not_installed/);
    });
    expect(await stub.schemaVersion()).toBe(0);
  });
});

describe('unit status triggers (copy of transitions.ts)', () => {
  it('refuses a forbidden transition and a stale version', async () => {
    const { stub } = await installShop('triggers-example.myshopify.com');
    await runInDurableObject(stub, (store: ShopStore) => {
      store.createUnit('u1', 'gid://shopify/ProductVariant/1', 'loc-1', 'AVAILABLE');
      store.setUnitStatus('u1', 'ALLOCATED', 0);
      expect(() => store.setUnitStatus('u1', 'INCOMING', 1)).toThrow(/forbidden_transition/);
      expect(() => store.createUnit('u2', 'gid://shopify/ProductVariant/1', 'loc-1', 'ALLOCATED')).toThrow(/forbidden_transition/);
      expect(() => store.createUnit('u3', 'gid://shopify/ProductVariant/1', null, 'AVAILABLE')).toThrow(/CHECK/);
    });
  });
});

describe('embedded app entry', () => {
  it('serves the admin app index with the app client id, no cache and a frame-ancestors policy', async () => {
    const res = await SELF.fetch('https://staging.serialis.dev/?shop=example.myshopify.com');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<meta name="shopify-api-key" content="03fd014d5ce8c5b37ed75e6effaae74f"\s*\/?>/);
    expect(html).not.toContain('%SHOPIFY_API_KEY%');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Security-Policy')).toContain('frame-ancestors https://admin.shopify.com https://*.myshopify.com');
    expect(res.headers.get('Content-Security-Policy')).toContain('https://cdn.shopify.com');
    expect(res.headers.get('X-Frame-Options')).toBeNull();
    // Every navigation route of the SPA answers with the same document.
    for (const path of ['/units', '/units/abc', '/tracked-items', '/anomalies', '/imports', '/settings', '/settings/health', '/start']) {
      const r = await SELF.fetch(`https://staging.serialis.dev${path}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('Cache-Control')).toBe('no-store');
    }
  });
});
