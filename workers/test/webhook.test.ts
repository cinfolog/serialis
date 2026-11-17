import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ShopStore } from '../src/shop-store.js';

const SECRET = 'test-secret';
const SHOP = 'demo-shop.myshopify.com';

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return btoa(String.fromCharCode(...sig));
}

function post(body: string, hmac: string, webhookId = 'wh-1') {
  return SELF.fetch('https://hooks.serialis.dev/webhooks/shopify', {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': hmac,
      'X-Shopify-Shop-Domain': SHOP,
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
    const body = '{"id":1042}';
    const hmac = await sign(body);
    const first = await post(body, hmac, 'wh-42');
    expect(await first.json()).toEqual({ stored: true });
    const retry = await post(body, hmac, 'wh-42');
    expect(await retry.json()).toEqual({ stored: false, reason: 'duplicate' });

    const stub = env.SHOP_STORE.get(env.SHOP_STORE.idFromName(SHOP));
    expect(await stub.inboxCount()).toBe(1);
    expect(await stub.schemaVersion()).toBe(2);
  });
});

describe('unit status triggers (copy of transitions.ts)', () => {
  it('refuses a forbidden transition and a stale version', async () => {
    const stub = env.SHOP_STORE.get(env.SHOP_STORE.idFromName('triggers.myshopify.com'));
    await runInDurableObject(stub, (store: ShopStore) => {
      store.createUnit('u1', 'gid://shopify/ProductVariant/1', 'loc-1', 'AVAILABLE');
      store.setUnitStatus('u1', 'ALLOCATED', 0);
      expect(() => store.setUnitStatus('u1', 'INCOMING', 1)).toThrow(/forbidden_transition/);
      expect(() => store.createUnit('u2', 'gid://shopify/ProductVariant/1', 'loc-1', 'ALLOCATED')).toThrow(/forbidden_transition/);
      expect(() => store.createUnit('u3', 'gid://shopify/ProductVariant/1', null, 'AVAILABLE')).toThrow(/CHECK/);
    });
  });
});
