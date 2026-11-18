import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registryRow, routingKey, shopStub } from '../src/routing.js';
import type { ShopStore } from '../src/shop-store.js';
import { json, mockShopify, sessionToken } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function me(token: string | null, query = '') {
  return SELF.fetch(`https://staging.serialis.dev/api/me${query}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

let shopIds = 76;

function shopQuery(country: string) {
  shopIds += 1;
  const id = `gid://shopify/Shop/${shopIds}`;
  return () => json({ data: { shop: { id, billingAddress: { countryCodeV2: country } } }, extensions: { cost: { requestedQueryCost: 1, actualQueryCost: 1, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1999, restoreRate: 100 } } } });
}

describe('GET /api/me — session token authentication (spec 16)', () => {
  it('rejects missing, forged, expired, wrong-audience and cross-shop tokens with the retry header', async () => {
    const shop = 'auth-example.myshopify.com';
    const cases: Array<[string | null, string, string]> = [
      [null, '', 'missing'],
      [await sessionToken(shop, {}, 'wrong-secret'), '', 'bad_signature'],
      [await sessionToken(shop, { exp: Math.floor(Date.now() / 1000) - 60 }), '', 'expired'],
      [await sessionToken(shop, { aud: 'other-app' }), '', 'wrong_audience'],
      [await sessionToken(shop), '?shop=other-example.myshopify.com', 'shop_mismatch'],
      [await sessionToken(shop, { iss: 'https://other-example.myshopify.com/admin' }), '', 'shop_mismatch'],
    ];
    for (const [token, query, reason] of cases) {
      const res = await me(token, query);
      expect(res.status).toBe(401);
      expect(res.headers.get('X-Shopify-Retry-Invalid-Session-Request')).toBe('1');
      expect(await res.json()).toEqual({ error: 'invalid_session_token', reason });
    }
  });
});

describe('installation (spec 9.14, 10.5, 13.9)', () => {
  it('installs an EU shop: online exchange, placement, registry, KV, offline exchange in the object', async () => {
    const shop = 'eu-example.myshopify.com';
    const mock = mockShopify({ graphql: shopQuery('FR') });
    const res = await me(await sessionToken(shop));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ shop, installed: true, status: 'active', installCount: 1, token: 'valid' });

    // Online token for the shop query, then the expiring offline exchange.
    expect(mock.calls.map((c) => c.kind)).toEqual(['online', 'graphql', 'offline']);
    expect(mock.of('graphql')[0]!.token).toBe('online_test');
    expect(mock.of('offline')[0]!.body).toMatchObject({ expiring: '1', requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token' });

    const row = await registryRow(env, shop);
    expect(row).toMatchObject({ object_name: `eu:${shop}`, jurisdiction: 'eu', location_hint: null, status: 'active', install_count: 1, shopify_shop_gid: 'gid://shopify/Shop/77' });
    expect(await env.SHOP_ROUTING.get(routingKey(shop), 'json')).toEqual({ objectName: `eu:${shop}`, jurisdiction: 'eu', locationHint: null, status: 'active' });

    // Tokens are stored encrypted: the plaintext never appears in the row.
    const stub = shopStub(env, { objectName: `eu:${shop}`, jurisdiction: 'eu', locationHint: null });
    await runInDurableObject(stub, (_store: ShopStore, state: DurableObjectState) => {
      const tokenRow = state.storage.sql.exec<{ access_token_enc: ArrayBuffer; refresh_token_enc: ArrayBuffer; key_version: number; status: string }>('SELECT * FROM shopify_token').one();
      const bytes = new TextDecoder('latin1').decode(new Uint8Array(tokenRow.access_token_enc)) + new TextDecoder('latin1').decode(new Uint8Array(tokenRow.refresh_token_enc));
      expect(bytes).not.toContain('shpat_test');
      expect(bytes).not.toContain('shprt_test');
      expect(tokenRow.key_version).toBe(1);
      expect(tokenRow.status).toBe('valid');
    });
    expect(await stub.accessToken()).toMatch(/^shpat_test_/);

    // Second opening: no new exchange, same installation.
    const again = await me(await sessionToken(shop));
    expect(await again.json()).toMatchObject({ installCount: 1, token: 'valid' });
    expect(mock.calls.filter((c) => c.kind !== 'graphql').length).toBe(2);
  });

  it('places a non-EU shop globally with a location hint', async () => {
    const shop = 'us-example.myshopify.com';
    mockShopify({ graphql: shopQuery('US') });
    expect((await me(await sessionToken(shop))).status).toBe(200);
    expect(await registryRow(env, shop)).toMatchObject({ object_name: `global:${shop}`, jurisdiction: null, location_hint: 'enam' });
  });

  it('answers 401 when Shopify refuses the session token, 502 when Shopify is down', async () => {
    mockShopify({ online: () => json({ error: 'invalid_subject_token' }, 400) });
    const refused = await me(await sessionToken('refused-example.myshopify.com'));
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ reason: 'rejected_by_shopify' });
    vi.restoreAllMocks();

    mockShopify({ online: () => new Response('', { status: 503 }) });
    const down = await me(await sessionToken('down-example.myshopify.com'));
    expect(down.status).toBe(502);
    expect(await registryRow(env, 'down-example.myshopify.com')).toBeNull();
  });
});
