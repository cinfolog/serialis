/**
 * Flows of the MVP exit criteria beyond T-MVP (spec 19.4): T-E2E-04, 04b, 05, 19, 40, 114.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { addRefs, anomalies, assertConsistent, createHarness, json, sim_level, track, type Harness } from './e2e-harness.js';

const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.restore();
});

async function setup(name: string, stock = 0) {
  const h = await createHarness(name);
  harnesses.push(h);
  const loc = h.sim.addLocation('Main');
  const loc2 = h.sim.addLocation('Second');
  const { variantIds, itemIds } = h.sim.addProduct('Bike', [{ sku: 'BIKE', stock: { [loc]: stock, [loc2]: 0 } }]);
  return { h, loc, loc2, variant: variantIds[0]!, item: itemIds[0]! };
}

async function lineAllocations(h: Harness, orderGid: string) {
  return (await json(await h.api('GET', `/orders/${orderGid.split('/').pop()}/allocations`), 200)).lines[0].allocations as Array<{ id: string; unitId: string; ref: string; status: string; locationId: string; toConfirm: boolean }>;
}

describe('T-E2E-04 / 04b — cancellations', () => {
  it('partial refund of one unit of three: the last allocated is released, the two others stay', async () => {
    const { h, loc, variant } = await setup('e2e04b');
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['Z-1', 'Z-2', 'Z-3']);
    await h.drain();
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 3 }] });
    await h.drain();
    const before = (await lineAllocations(h, order.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
    order.refund({ lines: [{ line: 0, quantity: 1, restockType: 'CANCEL' }] });
    await h.drain();
    const after = await lineAllocations(h, order.id);
    expect(after.filter((a) => a.status === 'active').map((a) => a.id).sort()).toEqual(before.slice(0, 2).map((a) => a.id).sort());
    expect(after.find((a) => a.id === before[2]!.id)!.status).toBe('released');
    expect((await json(await h.api('GET', `/units/${before[2]!.unitId}`), 200)).state).toBe('AVAILABLE');
    await assertConsistent(h);
  });

  it('total cancellation without restock: units to verify, no automatic write', async () => {
    const { h, loc, variant } = await setup('e2e04');
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['W-1', 'W-2']);
    await h.drain();
    const writes = h.sim.callCount('inventoryAdjustQuantities');
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 2 }] });
    await h.drain();
    order.cancel({ restock: false });
    await h.drain();
    expect(await anomalies(h, 'unit_to_verify')).toHaveLength(2);
    expect((await h.query<{ n: number }>("SELECT count(*) AS n FROM units WHERE status = 'TO_VERIFY'"))[0]!.n).toBe(2);
    expect(h.sim.callCount('inventoryAdjustQuantities')).toBe(writes);
    await assertConsistent(h);
  });
});

describe('T-E2E-05 — partial then total shipment', () => {
  it('provisional designation on the partial shipment, no confirmation left once the whole line left', async () => {
    const { h, loc, variant } = await setup('e2e05');
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['F-1', 'F-2', 'F-3']);
    await h.drain();
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 3 }] });
    await h.drain();
    order.fulfill({ lines: [{ line: 0, quantity: 1 }] });
    await h.drain();
    expect(await anomalies(h, 'shipped_unit_to_confirm')).toHaveLength(1);
    order.fulfill();
    await h.drain();
    const allocations = await lineAllocations(h, order.id);
    expect(allocations.map((a) => [a.status, a.toConfirm])).toEqual([
      ['fulfilled', false],
      ['fulfilled', false],
      ['fulfilled', false],
    ]);
    expect(await anomalies(h, 'shipped_unit_to_confirm')).toHaveLength(0);
    await assertConsistent(h);
  });
});

describe('T-E2E-19 — fulfillment order split then partly moved', () => {
  it('allocations kept for the part that stayed, recomputed at the new location for the moved part', async () => {
    const { h, loc, loc2, variant } = await setup('e2e19');
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['K-1', 'K-2', 'K-3']);
    await addRefs(h, variant, loc2, ['N-1']);
    await h.drain();
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 3, locationId: loc }] });
    await h.drain();
    const before = await lineAllocations(h, order.id);
    order.splitFulfillmentOrder(order.fulfillmentOrders[0]!.id, [{ line: 0, quantity: 1 }]);
    await h.drain();
    expect((await lineAllocations(h, order.id)).filter((a) => a.status === 'active').map((a) => a.id).sort()).toEqual(before.map((a) => a.id).sort());
    const moved = order.fulfillmentOrders.find((fo) => fo.lines[0]!.remainingQuantity === 1 && fo.status === 'OPEN')!;
    order.moveFulfillmentOrder(moved.id, loc2);
    await h.drain();
    const after = (await lineAllocations(h, order.id)).filter((a) => a.status === 'active');
    expect(after.filter((a) => a.locationId === loc)).toHaveLength(2);
    expect(after.filter((a) => a.locationId === loc2).map((a) => a.ref)).toEqual(['N-1']);
    expect(after.filter((a) => a.locationId === loc).every((a) => before.some((b) => b.id === a.id))).toBe(true);
    await assertConsistent(h);
  });
});

describe('T-E2E-40 / T-E2E-114 — activation on existing stock', () => {
  it('12 in stock and 3 open orders, open orders not applied: no critical anomaly, 12 registered without write, 13th refused, phase ends', async () => {
    const { h, loc, variant, item } = await setup('e2e40', 12);
    const open = [1, 2, 3].map(() => h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] }));
    await h.deliver({ drop: 1 }); // created before the app tracked the variant
    await track(h, [variant]);
    await h.drain();
    expect((await anomalies(h)).filter((a) => a.severity === 'critical')).toEqual([]);
    const refs = Array.from({ length: 13 }, (_, i) => `INIT-${i + 1}`);
    const res = await addRefs(h, variant, loc, refs, true);
    expect(res.created).toHaveLength(12);
    expect(res.rejected).toEqual([{ index: 12, ref: 'INIT-13', code: 'validation_failed', detail: 'no_usable_deficit' }]);
    await h.drain();
    expect(sim_level(h, item, loc).on_hand).toBe(12);
    expect(h.sim.callCount('inventoryAdjustQuantities')).toBe(0);
    expect((await h.query<{ initializing: number }>('SELECT initializing FROM tracked_items'))[0]!.initializing).toBe(0);
    // Lines older than the tracking are neither allocated nor waiting.
    for (const o of open) expect(await lineAllocations(h, o.id)).toEqual([]);
    expect(await h.query('SELECT 1 FROM uncovered_lines')).toEqual([]);
    await assertConsistent(h);
  });

  it('available 8 and safety stock 2: the 10 units are registered without write, I1 holds, the phase ends', async () => {
    const { h, loc, variant, item } = await setup('e2e114', 8);
    h.sim.merchant.adjustInventory({ itemId: item, locationId: loc, delta: 2, name: 'safety_stock' });
    await h.deliver({ drop: 1 });
    await track(h, [variant]);
    const res = await addRefs(h, variant, loc, Array.from({ length: 10 }, (_, i) => `SS-${i + 1}`), true);
    expect(res.created).toHaveLength(10);
    await h.drain();
    expect(h.sim.callCount('inventoryAdjustQuantities')).toBe(0);
    expect((await h.query<{ initializing: number }>('SELECT initializing FROM tracked_items'))[0]!.initializing).toBe(0);
    await assertConsistent(h);
  });
});
