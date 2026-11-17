import { describe, expect, it } from 'vitest';
import { ADJUST, fixture, gql, level } from './helpers.js';

const change = (f: ReturnType<typeof fixture>, key: string, from: number, delta = -1) =>
  gql(f.sim, ADJUST, { key, input: { reason: 'x', name: 'available', changes: [{ inventoryItemId: f.itemId, locationId: f.loc, delta, changeFromQuantity: from }] } });

describe('throttling', () => {
  it('reports throttleStatus, drains the bucket and returns THROTTLED when exceeded, restoring with time', async () => {
    const f = fixture({ bucket: { maximumAvailable: 100, restoreRate: 10 } });
    const q = `{ productVariants(first: 20) { nodes { id inventoryItem { id } } } }`;
    const a = await gql(f.sim, q);
    const cost = a.extensions.cost;
    expect(cost.requestedQueryCost).toBe(1 + 20 * 2);
    expect(cost.actualQueryCost).toBe(1 + 2 * 2); // only 2 variants exist: actual cost is lower than requested
    expect(cost.throttleStatus).toEqual({ maximumAvailable: 100, currentlyAvailable: 100 - cost.actualQueryCost, restoreRate: 10 });
    f.sim.setBucket(5);
    const c = await gql(f.sim, q);
    expect(c.errors[0]).toMatchObject({ message: 'Throttled', extensions: { code: 'THROTTLED' } });
    expect(c.extensions.cost).toMatchObject({ requestedQueryCost: 41, actualQueryCost: null, throttleStatus: { currentlyAvailable: 5 } });
    f.sim.clock.advance(4000);
    expect((await gql(f.sim, q)).errors).toBeUndefined();
  });

  it('refuses a single query above the max cost', async () => {
    const f = fixture();
    const r = await gql(f.sim, `{ productVariants(first: 250) { nodes { id product { id } inventoryItem { id inventoryLevels(first: 5) { nodes { id } } } } } }`);
    expect(r.errors[0].extensions).toMatchObject({ code: 'MAX_COST_EXCEEDED', maxCost: 1000 });
  });
});

describe('fault injection', () => {
  it('http 5xx on the 2nd and 3rd call of an operation only', async () => {
    const f = fixture();
    f.sim.faults.add({ operation: 'inventoryAdjustQuantities', calls: { from: 2, to: 3 }, fault: { kind: 'http', status: 503 } });
    const res = async (k: string, from: number) => f.sim.fetch(new Request('https://sim-shop.myshopify.com/admin/api/2026-10/graphql.json', { method: 'POST', body: JSON.stringify({ query: ADJUST, variables: { key: k, input: { reason: 'x', name: 'available', changes: [{ inventoryItemId: f.itemId, locationId: f.loc, delta: -1, changeFromQuantity: from }] } } }) }));
    expect((await res('a', 10)).status).toBe(200);
    expect((await res('b', 9)).status).toBe(503);
    expect((await res('b', 9)).status).toBe(503);
    expect((await res('b', 9)).status).toBe(200);
    expect(level(f.sim, f.itemId, f.loc).available).toBe(8);
    expect(f.sim.callCount('inventoryAdjustQuantities')).toBe(4);
  });

  it('lost response (timeout after apply): same key replays the stored result, applied once', async () => {
    const f = fixture();
    f.sim.faults.add({ operation: 'inventoryAdjustQuantities', calls: 1, fault: { kind: 'timeout', applied: true } });
    await expect(change(f, 'k', 10)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(level(f.sim, f.itemId, f.loc).available).toBe(9);
    const r = await change(f, 'k', 10);
    expect(r.data.inventoryAdjustQuantities.userErrors).toEqual([]);
    expect(level(f.sim, f.itemId, f.loc).available).toBe(9);
  });

  it('timeout before apply leaves the shop untouched', async () => {
    const f = fixture();
    f.sim.faults.add({ operation: 'inventoryAdjustQuantities', times: 1, fault: { kind: 'timeout' } });
    await expect(change(f, 'k', 10)).rejects.toThrow();
    expect(level(f.sim, f.itemId, f.loc).available).toBe(10);
    expect((await change(f, 'k', 10)).data.inventoryAdjustQuantities.userErrors).toEqual([]);
  });

  it('throttled fault, graphqlError and userError faults', async () => {
    const f = fixture();
    f.sim.faults.add({ operation: 'inventoryAdjustQuantities', calls: 1, fault: { kind: 'throttled' } });
    f.sim.faults.add({ operation: 'inventoryAdjustQuantities', calls: 2, fault: { kind: 'graphqlError', code: 'IDEMPOTENCY_CONCURRENT_REQUEST' } });
    f.sim.faults.add({ operation: 'inventoryAdjustQuantities', calls: 3, fault: { kind: 'userError', code: 'ADJUST_QUANTITIES_FAILED' } });
    expect((await change(f, 'k', 10)).errors[0].extensions.code).toBe('THROTTLED');
    expect((await change(f, 'k', 10)).errors[0].extensions.code).toBe('IDEMPOTENCY_CONCURRENT_REQUEST');
    const ue = await change(f, 'k', 10);
    expect(ue.data.inventoryAdjustQuantities.userErrors[0].code).toBe('ADJUST_QUANTITIES_FAILED');
    expect(level(f.sim, f.itemId, f.loc).available).toBe(10);
    expect(f.sim.requests.map((r) => r.fault)).toEqual(['throttled', 'graphqlError', 'userError']);
    expect((await change(f, 'k2', 10)).data.inventoryAdjustQuantities.userErrors).toEqual([]);
  });

  it('staleChange: a concurrent writer really moves the quantity, so changeFromQuantity is stale and a webhook fires', async () => {
    const f = fixture();
    f.sim.faults.add({ operation: 'inventoryAdjustQuantities', calls: 1, fault: { kind: 'staleChange' } });
    const r = await change(f, 'k1', 10);
    expect(r.data.inventoryAdjustQuantities.userErrors[0].code).toBe('CHANGE_FROM_QUANTITY_STALE');
    expect(level(f.sim, f.itemId, f.loc).available).toBe(11);
    expect(f.sim.shop.events.filter((e) => e.topic === 'inventory_levels/update')).toHaveLength(1);
    const retry = await change(f, 'k2', 11);
    expect(retry.data.inventoryAdjustQuantities.userErrors).toEqual([]);
  });

  it('wildcard rule with times, and removal', async () => {
    const f = fixture();
    const off = f.sim.faults.add({ operation: '*', fault: { kind: 'http', status: 402 } });
    const res = await f.sim.fetch(new Request('https://sim-shop.myshopify.com/admin/api/2026-10/graphql.json', { method: 'POST', body: '{"query":"{ shop { name } }"}' }));
    expect(res.status).toBe(402);
    off();
    expect((await gql(f.sim, '{ shop { name } }')).data.shop.name).toBe('Sim Shop');
  });
});
