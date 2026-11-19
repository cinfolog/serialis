/**
 * Second browser recette (real Shopify admin, staging): returns not restocked, identification with a unit of
 * another order, order block data, source of manual designations, order metafield definition.
 * The simulator mirrors what Shopify sends: dispositions without a location for « Not restocked », return
 * processing (`returnProcess`) that may record no disposition at all, webhooks that name the reverse fulfillment
 * order or the return but not the order (workers/DECISIONS.md 74 to 78).
 */
import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { addRefs, anomalies, assertConsistent, createHarness, json, sim_level, track, type Harness } from './e2e-harness.js';

const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.restore();
});

async function setup(name: string) {
  const h = await createHarness(name);
  harnesses.push(h);
  const loc = h.sim.addLocation('Main');
  const { variantIds, itemIds } = h.sim.addProduct('Bike', [{ sku: 'BIKE-M', stock: { [loc]: 0 } }]);
  return { h, loc, variant: variantIds[0]!, item: itemIds[0]! };
}

const numeric = (gid: string) => gid.split('/').pop()!;

async function unitState(h: Harness, unitId: string): Promise<string> {
  return (await json(await h.api('GET', `/units/${unitId}`), 200)).state;
}

/** A shipped order of `qty` units with an open return of `returned` of them. */
async function returnedOrder(name: string, qty = 1, returned = 1) {
  const s = await setup(name);
  const { h, loc, variant } = s;
  await track(h, [variant]);
  await addRefs(h, variant, loc, ['VR-001', 'VR-002', 'VR-003', 'VR-004', 'VR-005']);
  await h.drain();
  const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: qty }] });
  await h.drain();
  order.fulfill();
  await h.drain();
  order.createReturn({ lines: [{ line: 0, quantity: returned }] });
  await h.drain();
  const lines = (await json(await h.api('GET', `/orders/${numeric(order.id)}/allocations`), 200)).lines;
  const sold = lines[0].allocations as Array<{ id: string; unitId: string; ref: string; status: string; source: string }>;
  const ret = order.returns[0]!;
  return { ...s, order, sold, ret, returnLine: ret.lines[0]!.id };
}

describe('recette 2, item 1 — return « Not restocked » leaves no unit orphaned', () => {
  it('admin flow: receive › Not restocked, then close (no disposition recorded, webhooks without the order): identification anomaly, then scrapped without stock write', async () => {
    const { h, loc, item, order, sold, ret } = await returnedOrder('r2-notrestocked');
    expect(await unitState(h, sold[0]!.unitId)).toBe('RETURN_PENDING');
    const writes = h.sim.callCount('inventoryAdjustQuantities') + h.sim.callCount('inventoryMoveQuantities');
    const before = sim_level(h, item, loc);

    order.processReturn(ret.id, [{ line: 0, quantity: 1, disposition: 'NOT_RESTOCKED' }]);
    expect(h.sim.webhooks.pending().map((e) => e.topic)).toEqual(['returns/process', 'returns/close']);
    await h.drain();
    // S-17 (default yes): the merchant can finish by typing the ref.
    const toIdentify = await anomalies(h, 'return_unidentified');
    expect(toIdentify).toHaveLength(1);
    expect(await unitState(h, sold[0]!.unitId)).toBe('RETURN_PENDING');

    const resolved = await json(await h.api('POST', `/anomalies/${toIdentify[0]!.id}/resolve`, { action: 'identify', params: { ref: sold[0]!.ref } }), 200);
    expect(resolved.status).toBe('resolved');
    await h.drain();
    expect(await unitState(h, sold[0]!.unitId)).toBe('SCRAPPED');
    expect(await anomalies(h)).toEqual([]);
    expect(h.sim.callCount('inventoryAdjustQuantities') + h.sim.callCount('inventoryMoveQuantities')).toBe(writes);
    expect(sim_level(h, item, loc)).toEqual(before);
    await assertConsistent(h);
  });

  it('NOT_RESTOCKED disposition without location, announced only by reverse_fulfillment_orders/dispose (payload without the order): scrapped at its location', async () => {
    const { h, loc, order, sold, ret, returnLine } = await returnedOrder('r2-dispose');
    await json(await h.api('POST', `/returns/${numeric(ret.id)}/identify`, { returnLineItemGid: returnLine, ref: sold[0]!.ref }), 202);
    await h.drain();
    order.dispose(ret.id, [{ line: 0, quantity: 1, disposition: 'NOT_RESTOCKED' }], { returnUpdate: false });
    expect(h.sim.webhooks.pending().map((e) => e.topic)).toEqual(['reverse_fulfillment_orders/dispose']);
    await h.drain();
    const unit = await json(await h.api('GET', `/units/${sold[0]!.unitId}`), 200);
    expect(unit.state).toBe('SCRAPPED');
    expect(unit.locationId).toBe(loc);
    expect(await anomalies(h)).toEqual([]);
    await assertConsistent(h);
  });

  it('MISSING disposition (no location): lost', async () => {
    const { h, order, sold, ret, returnLine } = await returnedOrder('r2-missing');
    await json(await h.api('POST', `/returns/${numeric(ret.id)}/identify`, { returnLineItemGid: returnLine, ref: sold[0]!.ref }), 202);
    order.dispose(ret.id, [{ line: 0, quantity: 1, disposition: 'MISSING' }], { returnUpdate: false });
    await h.drain();
    expect(await unitState(h, sold[0]!.unitId)).toBe('LOST');
    await assertConsistent(h);
  });

  it('return closed without any disposition (returns/close without the order): not restocked, scrapped', async () => {
    const { h, order, sold, ret, returnLine } = await returnedOrder('r2-closed');
    await json(await h.api('POST', `/returns/${numeric(ret.id)}/identify`, { returnLineItemGid: returnLine, ref: sold[0]!.ref }), 202);
    await h.drain();
    order.closeReturn(ret.id, { minimalPayload: true });
    await h.drain();
    expect(await unitState(h, sold[0]!.unitId)).toBe('SCRAPPED');
    await assertConsistent(h);
  });

  it('restocked part of a processed line still restocks; the rest is scrapped', async () => {
    const { h, loc, item, order, sold, ret, returnLine } = await returnedOrder('r2-mixed', 2, 2);
    for (const a of sold) await json(await h.api('POST', `/returns/${numeric(ret.id)}/identify`, { returnLineItemGid: returnLine, ref: a.ref }), 202);
    await h.drain();
    order.processReturn(ret.id, [
      { line: 0, quantity: 1, disposition: 'RESTOCKED', locationId: loc },
      { line: 0, quantity: 1, disposition: 'NOT_RESTOCKED' },
    ]);
    await h.drain();
    const states = await Promise.all(sold.map((a) => unitState(h, a.unitId)));
    expect(states.sort()).toEqual(['AVAILABLE', 'SCRAPPED']);
    expect(sim_level(h, item, loc).available).toBe(3 + 1);
    await assertConsistent(h);
  });

  it('periodic reconciliation (R2) resolves a RETURN_PENDING unit whose return was closed while every webhook was lost', async () => {
    const { h, order, sold, ret, returnLine } = await returnedOrder('r2-recon');
    await json(await h.api('POST', `/returns/${numeric(ret.id)}/identify`, { returnLineItemGid: returnLine, ref: sold[0]!.ref }), 202);
    await h.drain();
    order.processReturn(ret.id, [{ line: 0, quantity: 1, disposition: 'NOT_RESTOCKED' }]);
    await h.deliver({ drop: 1 });
    await h.drain();
    expect(await unitState(h, sold[0]!.unitId)).toBe('RETURN_PENDING');

    // Within the hour: not re-read. Past it: re-read by R2.
    const reads = h.sim.callCount('order');
    await h.run("UPDATE tasks SET run_at = 0 WHERE key = 'recon:R2'");
    await h.step();
    await h.drain();
    expect(h.sim.callCount('order')).toBe(reads);
    await h.run('UPDATE order_sync SET last_synced_at = ? WHERE order_gid = ?', Date.now() - 61 * 60_000, order.id);
    await h.run("UPDATE tasks SET run_at = 0 WHERE key = 'recon:R2'");
    await h.step();
    await h.drain();
    expect(await unitState(h, sold[0]!.unitId)).toBe('SCRAPPED');
    await assertConsistent(h);
  });
});

describe('recette 2, item 2 — identification with a unit of another order', () => {
  it('opens return_unit_mismatch and closes return_to_identify (from the anomaly and from the identify route)', async () => {
    const { h, loc, variant, order, sold, ret } = await returnedOrder('r2-mismatch');
    // A unit sold on another order.
    const other = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] });
    await h.drain();
    other.fulfill();
    await h.drain();
    const otherUnit = (await json(await h.api('GET', `/orders/${numeric(other.id)}/allocations`), 200)).lines[0].allocations[0];
    order.dispose(ret.id, [{ line: 0, quantity: 1, disposition: 'RESTOCKED', locationId: loc }]);
    await h.drain();
    const toIdentify = await anomalies(h, 'return_unidentified');
    expect(toIdentify).toHaveLength(1);

    await json(await h.api('POST', `/anomalies/${toIdentify[0]!.id}/resolve`, { action: 'identify', params: { ref: otherUnit.ref } }), 200);
    await h.drain();
    expect(await anomalies(h, 'return_unit_mismatch')).toHaveLength(1);
    expect(await anomalies(h, 'return_unidentified')).toEqual([]);
    // The expected unit waits for the resolution of the mismatch; no stock write, the restock stays explained.
    expect(await unitState(h, sold[0]!.unitId)).toBe('RETURN_PENDING');
    expect(await unitState(h, otherUnit.unitId)).toBe('SHIPPED');
    await assertConsistent(h);
  });
});

describe('recette 2, item 3 — order data of a returned line', () => {
  it('allocations carry the unit state and the line keeps its ordered quantity', async () => {
    const { h, order, sold } = await returnedOrder('r2-orderview');
    const line = (await json(await h.api('GET', `/orders/${numeric(order.id)}/allocations`), 200)).lines[0];
    expect(line.orderedQuantity).toBe(1);
    expect(line.allocations[0]).toMatchObject({ unitId: sold[0]!.unitId, status: 'fulfilled', unitState: 'RETURN_PENDING' });
  });
});

describe('recette 2, item 6 — source of manual designations', () => {
  it('allocation and replacement from the app or an extension: source pick; through the public API key: api', async () => {
    const { h, loc, variant } = await setup('r2-source');
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['S-1', 'S-2', 'S-3']);
    await h.drain();
    await json(await h.api('POST', '/automation/pause'), 200);
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 2 }] });
    await h.drain();
    const lineItemGid = (await json(await h.api('GET', `/orders/${numeric(order.id)}/allocations`), 200)).lines[0].lineItemGid;
    const manual = await json(await h.api('POST', '/allocations', { orderGid: order.id, lineItemGid, ref: 'S-1' }), 201);
    expect(manual.source).toBe('pick');
    const replaced = await json(await h.api('POST', `/allocations/${manual.id}/replace`, { ref: 'S-2' }), 201);
    expect(replaced.source).toBe('pick');
    const events = await h.query<{ data: string; actor_type: string; cause_type: string }>("SELECT data, actor_type, cause_type FROM unit_events WHERE type = 'allocated'");
    expect(events.map((e) => [JSON.parse(e.data).source, e.actor_type, e.cause_type])).toEqual([
      ['pick', 'user', 'ui_action'],
      ['pick', 'user', 'ui_action'],
    ]);

    const key = (await json(await h.api('POST', '/api-keys', { name: 'ERP', scopes: ['allocations:write', 'allocations:read'] }), 201)).key as string;
    const viaKey = await SELF.fetch('https://staging.serialis.dev/public/v1/allocations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ orderGid: order.id, lineItemGid, ref: 'S-3' }),
    });
    expect((await json(viaKey, 201)).source).toBe('api');
  });
});

describe('recette 2, item 7 — order metafield definition', () => {
  it('created once at installation (ORDER, serialis/units, json), reused when it already exists', async () => {
    const { h } = await setup('r2-definition');
    await h.drain();
    const defs = [...h.sim.shop.metafieldDefinitions.values()];
    expect(defs).toEqual([expect.objectContaining({ ownerType: 'ORDER', namespace: 'serialis', key: 'units', type: 'json' })]);
    expect(defs[0]!.name).toContain('Serialis');
    expect((await h.query("SELECT value FROM meta WHERE key = 'order_metafield_definition'"))[0]).toEqual({ value: defs[0]!.id });
    // Upgrade of an installed shop / reinstallation: the task runs again and reuses the definition.
    await h.run("DELETE FROM meta WHERE key = 'order_metafield_definition'");
    await h.run("INSERT INTO tasks (key, kind, priority, payload, status, run_at, deadline_at, attempts, created_at, updated_at) VALUES ('definitions', 'definitions', 45, '{}', 'pending', 0, 0, 0, 0, 0)");
    await h.drain();
    expect(h.sim.shop.metafieldDefinitions.size).toBe(1);
    expect(h.sim.callCount('metafieldDefinitionCreate')).toBe(1);
    expect((await h.query("SELECT value FROM meta WHERE key = 'order_metafield_definition'"))[0]).toEqual({ value: defs[0]!.id });
  });
});
