/**
 * MVP exit criteria at the Worker level (spec 18.2 T-MVP-01..10, 19.4), against the Shopify simulator.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { addRefs, anomalies, assertConsistent, createHarness, json, metafieldOf, sim_level, track, type Harness } from './e2e-harness.js';

const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.restore();
});

async function setup(name: string, stock: Record<string, number> = {}, sim: Parameters<typeof createHarness>[1] = {}) {
  const h = await createHarness(name, sim);
  harnesses.push(h);
  const loc = h.sim.addLocation('Main');
  const loc2 = h.sim.addLocation('Second');
  const { productId, variantIds, itemIds } = h.sim.addProduct('Bike', [
    { sku: 'BIKE-M', stock: { [loc]: stock.main ?? 0, [loc2]: stock.second ?? 0 } },
    { sku: 'BIKE-L', stock: { [loc]: 0 } },
  ]);
  const other = h.sim.addProduct('Helmet', [{ sku: 'HELMET', stock: { [loc]: 20 } }]);
  return { h, loc, loc2, productId, variant: variantIds[0]!, variantL: variantIds[1]!, item: itemIds[0]!, itemL: itemIds[1]!, untracked: other.variantIds[0]! };
}

describe('T-MVP-01 — refs added by the API (received / already counted)', () => {
  it('received: +n per location; already counted: no write, refused beyond the gap; duplicates refused with their row', async () => {
    const { h, loc, loc2, variant, item } = await setup('mvp01', { main: 0, second: 10 });
    await track(h, [variant]);
    const refs = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}-${String(i + 1).padStart(3, '0')}`);

    const a = await addRefs(h, variant, loc, refs('A', 50));
    expect(a.created).toHaveLength(50);
    await h.drain();
    expect(sim_level(h, item, loc).available).toBe(50);

    // 10 already in Shopify at the second location: 10 registered without write, the 11th refused.
    const b = await addRefs(h, variant, loc2, refs('B', 11), true);
    expect(b.created).toHaveLength(10);
    expect(b.rejected).toEqual([{ index: 10, ref: 'B-011', code: 'validation_failed', detail: 'no_usable_deficit' }]);
    const c = await addRefs(h, variant, loc2, refs('C', 50));
    expect(c.created).toHaveLength(50);
    await h.drain();
    expect(sim_level(h, item, loc2).available).toBe(60);
    expect(h.sim.callCount('inventoryAdjustQuantities')).toBe(2);

    // Duplicate: in the list and against the base, refused with the row in cause.
    const d = await addRefs(h, variant, loc, ['A-001', 'NEW-1', 'new-1']);
    expect(d.created.map((u: { ref: string }) => u.ref)).toEqual(['NEW-1']);
    expect(d.rejected).toEqual([
      { index: 0, ref: 'A-001', code: 'identifier_conflict', detail: 'already_known' },
      { index: 2, ref: 'new-1', code: 'identifier_conflict', detail: 'duplicate_in_list' },
    ]);
    // Atomic mode: nothing created when one ref is refused.
    const atomic = await h.api('POST', '/units/batch', { variantGid: variant, locationId: loc, refs: ['OK-1', 'A-002'], alreadyCounted: false, mode: 'atomic' });
    const problem = await json(atomic, 422);
    expect(problem).toMatchObject({ code: 'identifier_conflict', errors: [{ index: 1, code: 'identifier_conflict' }] });
    expect(atomic.headers.get('Content-Type')).toContain('application/problem+json');
    await h.drain();
    await assertConsistent(h);
  });
});

describe('T-MVP-02 — one ref per unit at order creation (F15)', () => {
  it('3 distinct units from the fulfillment order location, metafield with 3 refs, untracked line untouched', async () => {
    const { h, loc, variant, untracked } = await setup('mvp02');
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['SN-1', 'SN-2', 'SN-3', 'SN-4']);
    await h.drain();
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 3 }, { variantId: untracked, quantity: 1 }] });
    await h.drain();

    const allocs = await json(await h.api('GET', `/orders/${order.id.split('/').pop()}/allocations`), 200);
    expect(allocs.syncState).toBe('synced');
    const [tracked, other] = allocs.lines;
    expect(tracked.tracked).toBe(true);
    expect(tracked.allocations).toHaveLength(3);
    expect(new Set(tracked.allocations.map((a: { unitId: string }) => a.unitId)).size).toBe(3);
    expect(tracked.allocations.every((a: { locationId: string; status: string }) => a.locationId === loc && a.status === 'active')).toBe(true);
    expect(tracked.missing).toBe(0);
    expect(other).toMatchObject({ tracked: false, allocations: [], missing: 0 });

    const mf = metafieldOf(h, order.id)!;
    expect(mf.version).toBe(1);
    expect(mf.lines).toHaveLength(1);
    expect(mf.lines[0]!.units.map((u) => u.identifiers[0]!.value).sort()).toEqual(['SN-1', 'SN-2', 'SN-3']);
    // No line property written, no hold.
    expect(h.sim.callCount('orderUpdate')).toBe(0);
    expect(h.sim.callCount('fulfillmentOrderHold')).toBe(0);
    await assertConsistent(h);
  });
});

const numeric = (gid: string) => gid.split('/').pop()!;

async function orderLines(h: Harness, orderGid: string) {
  return (await json(await h.api('GET', `/orders/${numeric(orderGid)}/allocations`), 200)).lines as Array<{
    lineItemGid: string;
    tracked: boolean;
    missing: number;
    allocations: Array<{ id: string; unitId: string; ref: string; status: string; locationId: string; source: string; toConfirm: boolean }>;
  }>;
}

const active = (l: { allocations: Array<{ status: string }> }) => l.allocations.filter((a) => a.status === 'active');

describe('T-MVP-03 — replacement, two locations, quantity reduced', () => {
  it('replaced unit visible in metafield and API; units taken in each location; reduction releases the last allocated', async () => {
    const { h, loc, loc2, variant } = await setup('mvp03', {}, { sim: { merchant: { editPayloadRestock: true } } });
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['M-1', 'M-2', 'M-3', 'M-4']);
    await addRefs(h, variant, loc2, ['S-1', 'S-2']);
    await h.drain();

    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 3, locationId: loc }, { variantId: variant, quantity: 1, locationId: loc2 }] });
    await h.drain();
    let lines = await orderLines(h, order.id);
    expect(active(lines[0]!).map((a) => a.locationId)).toEqual([loc, loc, loc]);
    expect(active(lines[1]!).map((a) => a.locationId)).toEqual([loc2]);

    // Replace one unit by the remaining one at the main location (typed ref, last 4 characters not unique → full ref).
    const replaced = active(lines[0]!)[0]!;
    const res = await h.api('POST', `/allocations/${replaced.id}/replace`, { ref: 'M-4' });
    const next = await json(res, 201);
    expect(next).toMatchObject({ ref: 'M-4', status: 'active', locationId: loc });
    await h.drain();
    expect(metafieldOf(h, order.id)!.lines[0]!.units.map((u) => u.identifiers[0]!.value)).toContain('M-4');
    expect(metafieldOf(h, order.id)!.lines[0]!.units.map((u) => u.identifiers[0]!.value)).not.toContain(replaced.ref);

    // Quantity reduced by an edit with restock: the last allocated unit is released (S-08 default), back to AVAILABLE.
    lines = await orderLines(h, order.id);
    const lastAllocated = active(lines[0]!).sort((a, b) => (a.id < b.id ? -1 : 1)).at(-1)!;
    order.edit().reduceLine(0, { by: 1 }, { restock: true }).commit();
    await h.drain();
    lines = await orderLines(h, order.id);
    expect(active(lines[0]!)).toHaveLength(2);
    expect(active(lines[0]!).map((a) => a.id)).not.toContain(lastAllocated.id);
    const unit = await json(await h.api('GET', `/units/${lastAllocated.unitId}`), 200);
    expect(unit.state).toBe('AVAILABLE');
    await assertConsistent(h);
  });

  it('an edit without restock information sends the released unit to verification (F3)', async () => {
    const { h, loc, variant } = await setup('mvp03b');
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['V-1', 'V-2']);
    await h.drain();
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 2 }] });
    await h.drain();
    order.edit().reduceLine(0, { by: 1 }, { restock: false }).commit();
    await h.drain();
    const toVerify = await anomalies(h, 'unit_to_verify');
    expect(toVerify).toHaveLength(1);
    // Resolution "put back in stock": one write at most (T-E2E-37); Shopify did not restock here, so the app adds 1.
    const before = sim_level(h, (await h.query<{ inventory_item_gid: string }>('SELECT inventory_item_gid FROM tracked_items'))[0]!.inventory_item_gid, loc).available;
    const resolved = await json(await h.api('POST', `/anomalies/${toVerify[0]!.id}/resolve`, { action: 'restock' }), 200);
    expect(resolved.status).toBe('resolved');
    await h.drain();
    const item = (await h.query<{ inventory_item_gid: string }>('SELECT inventory_item_gid FROM tracked_items'))[0]!.inventory_item_gid;
    expect(sim_level(h, item, loc).available).toBe(before + 1);
    await assertConsistent(h);
  });
});

describe('T-MVP-04 — every channel, no free unit, unit received later', () => {
  it('admin, accelerated checkout and marketplace orders are allocated alike; insufficient_units then resolved at reception', async () => {
    const { h, loc, variant } = await setup('mvp04');
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['C-1', 'C-2', 'C-3']);
    await h.drain();
    const orders = ['shopify_draft_order', 'web', '580111'].map((source) => h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }], source }));
    await h.drain();
    for (const o of orders) expect(active((await orderLines(h, o.id))[0]!)).toHaveLength(1);

    const late = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] });
    await h.drain();
    expect(await anomalies(h, 'insufficient_units')).toHaveLength(1);
    expect((await orderLines(h, late.id))[0]!.missing).toBe(1);
    expect(h.sim.callCount('fulfillmentOrderHold')).toBe(0);

    await addRefs(h, variant, loc, ['C-4']);
    await h.drain();
    expect(active((await orderLines(h, late.id))[0]!).map((a) => a.ref)).toEqual(['C-4']);
    expect(await anomalies(h, 'insufficient_units')).toHaveLength(0);
    expect((await anomalies(h, 'insufficient_units', 'all'))[0]!.status).toBe('auto_resolved');
    await assertConsistent(h);
  });
});

describe('T-MVP-05 — burst of 50 orders on 10 units', () => {
  it('exactly 10 lines served, no unit twice, the others in insufficient_units', { timeout: 60_000 }, async () => {
    const { h, loc, variant } = await setup('mvp05');
    await track(h, [variant]);
    await addRefs(h, variant, loc, Array.from({ length: 10 }, (_, i) => `B-${i}`));
    await h.drain();
    for (let i = 0; i < 50; i++) h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] });
    await h.drain({ deliver: { concurrent: true } });
    const allocated = await h.query<{ n: number; d: number }>("SELECT count(*) AS n, count(DISTINCT unit_id) AS d FROM allocations WHERE status = 'active'");
    expect(allocated[0]).toEqual({ n: 10, d: 10 });
    expect(await anomalies(h, 'insufficient_units')).toHaveLength(40);
    await assertConsistent(h);
  });
});

describe('T-MVP-06 — removal, cancellation, returns with typed ref (S-17 = yes)', () => {
  it('removal before shipment, cancellation with restock releases the units', async () => {
    const { h, loc, variant } = await setup('mvp06a');
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['R-1', 'R-2', 'R-3']);
    await h.drain();
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 2 }] });
    await h.drain();
    const [first] = active((await orderLines(h, order.id))[0]!);
    expect((await h.api('DELETE', `/allocations/${first!.id}`)).status).toBe(204);
    await h.drain();
    // The removed unit is not taken again at once; the line gets the third unit.
    const after = active((await orderLines(h, order.id))[0]!);
    expect(after).toHaveLength(2);
    expect(after.map((a) => a.unitId)).not.toContain(first!.unitId);

    order.cancel({ restock: true });
    await h.drain();
    const units = await json(await h.api('GET', `/units?variant=${encodeURIComponent(variant)}&state=AVAILABLE`), 200);
    expect(units.items).toHaveLength(3);
    expect(await anomalies(h, 'unit_to_verify')).toHaveLength(0);
    await assertConsistent(h);
  });

  it('a restocked return is applied only once the ref is typed (full or last 4), on single- and multi-unit lines; another unit opens return_unit_mismatch', async () => {
    const { h, loc, variant } = await setup('mvp06b');
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['RET-AAAA1', 'RET-BBBB2', 'RET-CCCC3', 'RET-DDDD4']);
    await h.drain();
    const single = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] });
    const multi = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 2 }] });
    await h.drain();
    single.fulfill();
    multi.fulfill();
    await h.drain();
    const singleUnit = (await orderLines(h, single.id))[0]!.allocations[0]!;
    const multiUnits = (await orderLines(h, multi.id))[0]!.allocations;
    expect(singleUnit.status).toBe('fulfilled');

    single.createReturn({ lines: [{ line: 0, quantity: 1 }] });
    multi.createReturn({ lines: [{ line: 0, quantity: 1 }] });
    await h.drain();
    expect((await json(await h.api('GET', `/units/${singleUnit.unitId}`), 200)).state).toBe('RETURN_PENDING');
    single.dispose(single.returns[0]!.id, [{ line: 0, quantity: 1, disposition: 'RESTOCKED', locationId: loc }]);
    multi.dispose(multi.returns[0]!.id, [{ line: 0, quantity: 1, disposition: 'RESTOCKED', locationId: loc }]);
    await h.drain();
    // Not applied before the ref is typed.
    expect((await json(await h.api('GET', `/units/${singleUnit.unitId}`), 200)).state).toBe('RETURN_PENDING');
    expect(await anomalies(h, 'return_unidentified')).toHaveLength(2);
    await assertConsistent(h);

    // Single-unit line: last 4 characters.
    const singleReturnLine = single.returns[0]!.lines[0]!.id;
    const ok = await json(await h.api('POST', `/returns/${numeric(single.returns[0]!.id)}/identify`, { returnLineItemGid: singleReturnLine, ref: singleUnit.ref.slice(-4) }), 202);
    expect(ok.result).toBe('identified');
    // Multi-unit line: first a ref of another unit (mismatch), then the right full ref.
    const multiReturnLine = multi.returns[0]!.lines[0]!.id;
    const mismatch = await json(await h.api('POST', `/returns/${numeric(multi.returns[0]!.id)}/identify`, { returnLineItemGid: multiReturnLine, ref: singleUnit.ref }), 202);
    expect(mismatch.result).toBe('mismatch');
    await json(await h.api('POST', `/returns/${numeric(multi.returns[0]!.id)}/identify`, { returnLineItemGid: multiReturnLine, ref: multiUnits[1]!.ref }), 202);
    await h.drain();

    expect((await json(await h.api('GET', `/units/${singleUnit.unitId}`), 200)).state).toBe('AVAILABLE');
    expect((await json(await h.api('GET', `/units/${multiUnits[1]!.unitId}`), 200)).state).toBe('AVAILABLE');
    expect((await json(await h.api('GET', `/units/${multiUnits[0]!.unitId}`), 200)).state).toBe('SHIPPED');
    expect(await anomalies(h, 'return_unidentified')).toHaveLength(0);
    expect(await anomalies(h, 'return_unit_mismatch')).toHaveLength(1);
    await assertConsistent(h);
  });
});

describe('T-MVP-07 — mixed catalogue', () => {
  it('an order of untracked items schedules nothing and reads nothing', async () => {
    const { h, variant, untracked } = await setup('mvp07');
    await track(h, [variant]);
    await h.drain();
    const reads = h.sim.callCount('order');
    h.sim.merchant.createOrder({ lines: [{ variantId: untracked, quantity: 2 }] });
    await h.drain();
    expect(h.sim.callCount('order')).toBe(reads);
    expect(await h.query("SELECT key FROM tasks WHERE kind = 'sync_order'")).toEqual([]);
  });
});

describe('T-MVP-08 — without holds', () => {
  it('two of three allocated, insufficient_units, completed at reception; shipment without unit designated late; POS sale designated', async () => {
    const { h, loc, variant } = await setup('mvp08');
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['H-1', 'H-2']);
    await h.drain();
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 3 }] });
    await h.drain();
    expect(active((await orderLines(h, order.id))[0]!)).toHaveLength(2);
    expect(await anomalies(h, 'insufficient_units')).toHaveLength(1);
    await addRefs(h, variant, loc, ['H-3']);
    await h.drain();
    expect(active((await orderLines(h, order.id))[0]!)).toHaveLength(3);
    expect(await anomalies(h, 'insufficient_units')).toHaveLength(0);

    // Shipment of a line without unit (allocation suspended by the emergency stop).
    await addRefs(h, variant, loc, ['H-4', 'H-5']);
    await h.drain();
    await json(await h.api('POST', '/automation/pause'), 200);
    const second = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] });
    await h.drain();
    expect(await anomalies(h, 'awaiting_unit')).toHaveLength(1);
    second.fulfill();
    await h.drain();
    const shipped = await anomalies(h, 'shipped_without_unit');
    expect(shipped).toHaveLength(1);
    expect(shipped[0]!.severity).toBe('critical');
    await assertConsistent(h);
    const designated = await json(await h.api('POST', `/anomalies/${shipped[0]!.id}/resolve`, { action: 'designate', params: { ref: 'H-4' } }), 200);
    expect(designated.status).toBe('resolved');
    await h.drain();
    const line = (await orderLines(h, second.id))[0]!;
    expect(line.allocations).toEqual([expect.objectContaining({ ref: 'H-4', status: 'fulfilled', source: 'late' })]);
    await json(await h.api('POST', '/automation/resume'), 200);

    // POS sale of a tracked item: warning, designation from the order.
    const pos = h.sim.merchant.posSale({ locationId: loc, lines: [{ variantId: variant, quantity: 1 }] });
    await h.drain();
    const posAnomaly = await anomalies(h, 'pos_sold_without_unit');
    expect(posAnomaly).toHaveLength(1);
    expect(posAnomaly[0]!.severity).toBe('warning');
    const posLine = (await orderLines(h, pos.id))[0]!;
    await json(await h.api('POST', '/allocations', { orderGid: pos.id, lineItemGid: posLine.lineItemGid, ref: 'H-5' }), 201);
    await h.drain();
    expect(await anomalies(h, 'pos_sold_without_unit')).toHaveLength(0);
    expect(h.sim.callCount('fulfillmentOrderHold') + h.sim.callCount('fulfillmentOrderReleaseHold')).toBe(0);
    await assertConsistent(h);
  });
});

describe('T-MVP-09 — manual stock adjustment in Shopify', () => {
  it('gap anomaly after the grace period, no automatic correction', async () => {
    const { h, loc, variant, item } = await setup('mvp09');
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['G-1', 'G-2']);
    await h.drain();
    expect((await h.query<{ initializing: number }>('SELECT initializing FROM tracked_items'))[0]!.initializing).toBe(0);
    const writes = h.sim.callCount('inventoryAdjustQuantities');
    h.sim.merchant.adjustInventory({ itemId: item, locationId: loc, delta: 3 });
    await h.drain();
    // Within the grace period (S-22, 10 min): no anomaly yet, the check is rescheduled.
    expect(await anomalies(h, 'stock_mismatch_missing_units')).toHaveLength(0);
    await h.run('UPDATE inventory_levels SET gap_since = gap_since - 11 * 60000');
    await h.run("UPDATE tasks SET run_at = 0 WHERE kind = 'sync_inventory_level'");
    await h.drain();
    const gap = await anomalies(h, 'stock_mismatch_missing_units');
    expect(gap).toHaveLength(1);
    expect(JSON.parse(gap[0]!.details)).toMatchObject({ invariant: 'I1', shopify: 5, units: 2 });
    expect(h.sim.callCount('inventoryAdjustQuantities')).toBe(writes);
    // Registering the 3 units already counted closes the gap.
    await addRefs(h, variant, loc, ['G-3', 'G-4', 'G-5'], true);
    await h.drain();
    expect(await anomalies(h, 'stock_mismatch_missing_units')).toHaveLength(0);
    await assertConsistent(h);
  });
});

describe('T-MVP-10 — shipment of 2 units of 3', () => {
  it('shipped_unit_to_confirm, designation of the units that left by typed ref, history corrected, no stock write', async () => {
    const { h, loc, variant } = await setup('mvp10', { main: 3 });
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['P-1', 'P-2', 'P-3'], true);
    await h.drain();
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 3 }] });
    await h.drain();
    order.fulfill({ lines: [{ line: 0, quantity: 2 }] });
    await h.drain();
    const toConfirm = await anomalies(h, 'shipped_unit_to_confirm');
    expect(toConfirm).toHaveLength(1);
    let lines = await orderLines(h, order.id);
    const provisional = lines[0]!.allocations.filter((a) => a.toConfirm).map((a) => a.ref).sort();
    const stillAllocated = active(lines[0]!)[0]!;
    expect(provisional).toHaveLength(2);
    // The units that really left: the first provisional one and the one still allocated.
    await json(await h.api('POST', `/anomalies/${toConfirm[0]!.id}/resolve`, { action: 'confirm_shipped', params: { ref: provisional[0] } }), 200);
    const done = await json(await h.api('POST', `/anomalies/${toConfirm[0]!.id}/resolve`, { action: 'confirm_shipped', params: { ref: stillAllocated.ref } }), 200);
    expect(done.status).toBe('resolved');
    await h.drain();
    lines = await orderLines(h, order.id);
    expect(lines[0]!.allocations.filter((a) => a.status === 'fulfilled').map((a) => a.ref).sort()).toEqual([provisional[0], stillAllocated.ref].sort());
    expect(active(lines[0]!).map((a) => a.ref)).toEqual([provisional[1]]);
    expect(lines[0]!.allocations.every((a) => !a.toConfirm)).toBe(true);
    const back = active(lines[0]!)[0]!;
    const events = await json(await h.api('GET', `/units/${back.unitId}/events`), 200);
    expect(events.items[0]).toMatchObject({ type: 'shipment_designation_fixed', fromState: 'SHIPPED', toState: 'ALLOCATED' });
    expect(h.sim.callCount('inventoryAdjustQuantities') + h.sim.callCount('inventoryMoveQuantities')).toBe(0);
    expect(await anomalies(h, 'shipped_unit_to_confirm')).toHaveLength(0);
    await assertConsistent(h);
  });
});
