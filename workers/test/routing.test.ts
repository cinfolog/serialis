import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { objectNameFor, placementFor, registryRow, resolveRouting, routingKey, shopStub, type ShopRouting } from '../src/routing.js';
import type { ShopStore } from '../src/shop-store.js';
import { installShop, mockShopify, sendWebhook, sessionToken } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('placement and routing (spec 10.5)', () => {
  it('chooses the EU jurisdiction for EU/EEA shops and a location hint otherwise', () => {
    expect(placementFor('FR')).toEqual({ jurisdiction: 'eu', locationHint: null });
    expect(placementFor('no')).toEqual({ jurisdiction: 'eu', locationHint: null });
    expect(placementFor('RE')).toEqual({ jurisdiction: 'eu', locationHint: null });
    expect(placementFor('US')).toEqual({ jurisdiction: null, locationHint: 'enam' });
    expect(placementFor('GB')).toEqual({ jurisdiction: null, locationHint: 'weur' });
    expect(placementFor('AU')).toEqual({ jurisdiction: null, locationHint: 'oc' });
    expect(placementFor(null)).toEqual({ jurisdiction: null, locationHint: null });
    expect(objectNameFor('example.myshopify.com', 'eu')).toBe('eu:example.myshopify.com');
    expect(objectNameFor('example.myshopify.com', null)).toBe('global:example.myshopify.com');
  });

  it('addresses EU objects through the eu jurisdiction and passes the location hint', () => {
    const calls: string[] = [];
    const fakeNamespace = {
      idFromName: (name: string) => {
        calls.push(`id:${name}`);
        return { name } as unknown as DurableObjectId;
      },
      get: (_id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) => {
        calls.push(`get:${options?.locationHint ?? '-'}`);
        return {} as DurableObjectStub;
      },
      jurisdiction: (j: string) => {
        calls.push(`jurisdiction:${j}`);
        return fakeNamespace;
      },
    };
    const fakeEnv = { SHOP_STORE: fakeNamespace as unknown as typeof env.SHOP_STORE, ENVIRONMENT: 'production' as const };
    shopStub(fakeEnv, { objectName: 'eu:example.myshopify.com', jurisdiction: 'eu', locationHint: null });
    shopStub(fakeEnv, { objectName: 'global:example.myshopify.com', jurisdiction: null, locationHint: 'enam' });
    expect(calls).toEqual(['jurisdiction:eu', 'id:eu:example.myshopify.com', 'get:-', 'id:global:example.myshopify.com', 'get:enam']);

    // Outside development, a missing jurisdiction support is an error, never a silent fallback.
    const broken = { ...fakeNamespace, jurisdiction: () => { throw new Error('not implemented'); } };
    expect(() => shopStub({ SHOP_STORE: broken as unknown as typeof env.SHOP_STORE, ENVIRONMENT: 'production' }, { objectName: 'eu:x', jurisdiction: 'eu', locationHint: null })).toThrow();
  });

  it('confirms a negative KV answer with D1 and refreshes the KV copy', async () => {
    const shop = 'kv-stale-example.myshopify.com';
    expect(await resolveRouting(env, shop)).toBeNull();
    await installShop(shop);
    // KV says inactive (stale), D1 says active: D1 wins.
    await env.SHOP_ROUTING.put(routingKey(shop), JSON.stringify({ objectName: `global:${shop}`, jurisdiction: null, locationHint: null, status: 'inactive' }));
    const routing = await resolveRouting(env, shop);
    expect(routing?.status).toBe('active');
    expect((await env.SHOP_ROUTING.get<ShopRouting>(routingKey(shop), 'json'))?.status).toBe('active');
    // KV absent: D1 again.
    await env.SHOP_ROUTING.delete(routingKey(shop));
    expect((await resolveRouting(env, shop))?.objectName).toBe(`global:${shop}`);
  });
});

describe('uninstall and reinstall (spec 9.14, 10.5, 16.1)', () => {
  it('marks the shop inactive, drops tokens, suspends tasks, keeps data; only compliance topics still go through', async () => {
    const shop = 'uninstall-example.myshopify.com';
    mockShopify();
    const { routing, stub } = await installShop(shop);
    await stub.install({ shopDomain: shop, objectName: routing.objectName, sessionToken: 'jwt' });
    await sendWebhook({ shop, topic: 'orders/create', body: { id: 5 } });
    expect((await stub.status()).token).toBe('valid');

    const res = await sendWebhook({ shop, topic: 'app/uninstalled', body: { id: 1 }, triggeredAt: new Date().toISOString() });
    expect(await res.json()).toEqual({ stored: true, action: 'uninstall', shopState: 'uninstalled' });

    expect(await registryRow(env, shop)).toMatchObject({ status: 'inactive' });
    expect((await registryRow(env, shop))?.uninstalled_at).not.toBeNull();
    expect((await env.SHOP_ROUTING.get<ShopRouting>(routingKey(shop), 'json'))?.status).toBe('inactive');
    expect(await stub.status()).toMatchObject({ shopState: 'uninstalled', token: 'missing' });
    await runInDurableObject(stub, async (_s: ShopStore, state: DurableObjectState) => {
      expect(await state.storage.getAlarm()).toBeNull();
      // Data kept until shop/redact: the inbox and the pending task are still there.
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM tasks WHERE key NOT IN ('purge', 'recon:R4', 'definitions')").one().n).toBe(1);
    });

    // Ordinary topics are acknowledged and ignored.
    const ignored = await sendWebhook({ shop, topic: 'orders/updated', body: { id: 5 } });
    expect(await ignored.json()).toEqual({ stored: false, reason: 'inactive' });

    // Compliance topics are still stored, without customer details (P8).
    const redact = await sendWebhook({
      shop,
      topic: 'customers/redact',
      body: { shop_id: 1, shop_domain: shop, customer: { id: 9, email: 'someone@example.com', phone: '+330000' }, orders_to_redact: [5, 6] },
      webhookId: 'redact-1',
    });
    expect(await redact.json()).toEqual({ stored: true, action: 'compliance', shopState: 'uninstalled' });
    await runInDurableObject(stub, (_s: ShopStore, state: DurableObjectState) => {
      const request = state.storage.sql.exec('SELECT topic, order_gids, status FROM compliance_requests').one();
      expect(request).toEqual({ topic: 'customers/redact', order_gids: '["gid://shopify/Order/5","gid://shopify/Order/6"]', status: 'received' });
      const inbox = state.storage.sql.exec<{ payload: string }>("SELECT payload FROM inbox WHERE webhook_id = 'redact-1'").one();
      expect(inbox.payload).not.toContain('example.com');
      expect(inbox.payload).not.toContain('+330000');
    });
  });

  it('ignores an app/uninstalled triggered before the current installation', async () => {
    const shop = 'stale-uninstall-example.myshopify.com';
    const { stub } = await installShop(shop);
    const res = await sendWebhook({ shop, topic: 'app/uninstalled', body: {}, triggeredAt: '2020-01-01T00:00:00Z' });
    expect(await res.json()).toEqual({ stored: true, action: 'uninstall', shopState: 'active' });
    expect((await registryRow(env, shop))?.status).toBe('active');
    expect((await stub.status()).shopState).toBe('active');
  });

  it('reactivates the same object on reinstall and counts installations', async () => {
    const shop = 'reinstall-example.myshopify.com';
    const mock = mockShopify();
    const { stub } = await installShop(shop);
    await sendWebhook({ shop, topic: 'app/uninstalled', body: {}, triggeredAt: new Date().toISOString() });
    expect((await registryRow(env, shop))?.status).toBe('inactive');

    const res = await SELF.fetch('https://staging.serialis.dev/api/me', { headers: { Authorization: `Bearer ${await sessionToken(shop)}` } });
    expect(await res.json()).toMatchObject({ shop, status: 'active', installCount: 2, token: 'valid' });
    // Placement kept: no online exchange, only the offline one.
    expect(mock.calls.map((c) => c.kind)).toEqual(['offline']);
    expect(await registryRow(env, shop)).toMatchObject({ status: 'active', install_count: 2, uninstalled_at: null, object_name: `global:${shop}` });
    expect(await stub.status()).toMatchObject({ shopState: 'active', installCount: 2 });
    await runInDurableObject(stub, (_s: ShopStore, state: DurableObjectState) => {
      expect(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'full_reconcile_required'").one().value).toBe('1');
    });
  });
});
