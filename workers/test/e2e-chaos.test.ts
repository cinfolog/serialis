/**
 * Chaos and idempotence at the Worker level (spec 18.3: T-CH-01, 02, 04, 08, 10, T-IDEM-01, 02):
 * duplicated and reordered webhooks, lost webhooks, THROTTLED, stale `changeFromQuantity`,
 * timeouts after an applied write, transient user errors. Every scenario ends with the invariants.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DeliveryOptions } from '@serialis/shopify-sim';
import { addRefs, anomalies, assertConsistent, createHarness, json, metafieldOf, sim_level, track, type Harness } from './e2e-harness.js';

const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.restore();
});

async function setup(name: string) {
  const h = await createHarness(name);
  harnesses.push(h);
  const loc = h.sim.addLocation('Main');
  const { variantIds, itemIds } = h.sim.addProduct('Bike', [{ sku: 'BIKE', stock: { [loc]: 0 } }]);
  return { h, loc, variant: variantIds[0]!, item: itemIds[0]! };
}

/**
 * State that must not depend on how webhooks were delivered. Which unit goes to which order follows
 * the processing order (FIFO among the free units), so units are compared by count, not by ref.
 */
async function summary(h: Harness): Promise<unknown> {
  const units = await h.query('SELECT status, count(*) AS n FROM units GROUP BY status ORDER BY status');
  const allocations = await h.query(
    'SELECT order_gid, line_item_gid, status, to_confirm, count(*) AS n FROM allocations GROUP BY order_gid, line_item_gid, status, to_confirm ORDER BY order_gid, line_item_gid, status, to_confirm',
  );
  const open = (await anomalies(h)).map((a) => a.type).sort();
  const explained = await h.query("SELECT source_type, source_ref, quantity, direction FROM explained_quantities WHERE status = 'open' ORDER BY source_type, source_ref");
  return { units, allocations, open, explained };
}

/** A day of a shop: orders, partial shipment, edit, cancellation, return. */
async function scenario(name: string, delivery: Partial<DeliveryOptions>) {
  const { h, loc, variant } = await setup(name);
  await track(h, [variant]);
  await addRefs(h, variant, loc, ['D-01', 'D-02', 'D-03', 'D-04', 'D-05', 'D-06']);
  await h.drain();
  const a = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 2 }] });
  const b = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 3 }] });
  const c = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] });
  await h.drain({ deliver: delivery });
  a.fulfill();
  b.fulfill({ lines: [{ line: 0, quantity: 1 }] });
  c.cancel({ restock: true });
  await h.drain({ deliver: delivery });
  a.createReturn({ lines: [{ line: 0, quantity: 1 }] });
  b.edit().reduceLine(0, { by: 1 }, { restock: true }).commit();
  await h.drain({ deliver: delivery });
  return h;
}

describe('T-CH-02 — every webhook three times and out of order', () => {
  it('ends in the same state as a perfect delivery, explained quantities included', { timeout: 60_000 }, async () => {
    const perfect = await scenario('ch02-ok', {});
    const chaotic = await scenario('ch02-chaos', { duplicate: 2, reorder: 'shuffle', seed: 7 });
    expect(await summary(chaotic)).toEqual(await summary(perfect));
    await assertConsistent(perfect);
    await assertConsistent(chaotic);
    // Duplicates are absorbed by the inbox (same webhook id).
    const inbox = await chaotic.query<{ n: number; d: number }>('SELECT count(*) AS n, count(DISTINCT webhook_id) AS d FROM inbox');
    expect(inbox[0]!.n).toBe(inbox[0]!.d);
  });
});

describe('T-CH-01 — lost webhooks', () => {
  it('reconciliation R1 synchronizes the orders whose webhooks were lost', { timeout: 30_000 }, async () => {
    const { h, loc, variant } = await setup('ch01');
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['L-1', 'L-2', 'L-3', 'L-4', 'L-5']);
    await h.drain();
    const orders = Array.from({ length: 5 }, () => h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] }));
    // Every webhook lost.
    await h.deliver({ drop: 1 });
    await h.drain();
    expect(await h.query("SELECT 1 FROM allocations WHERE status = 'active'")).toHaveLength(0);
    await h.run("UPDATE tasks SET run_at = 0 WHERE key = 'recon:R1'");
    await h.drain();
    await h.run("UPDATE tasks SET run_at = 0 WHERE key = 'recon:R1'");
    await h.drain();
    const allocated = await h.query<{ order_gid: string }>("SELECT DISTINCT order_gid FROM allocations WHERE status = 'active'");
    expect(allocated.map((r) => r.order_gid).sort()).toEqual(orders.map((o) => o.id).sort());
    await assertConsistent(h);
  });
});

describe('T-CH-04 — writes interrupted, stale quantities', () => {
  it('a lost response after an applied write: same payload and key resent, applied once', async () => {
    const { h, loc, variant, item } = await setup('ch04a');
    await track(h, [variant]);
    h.sim.faults.add({ operation: 'inventoryAdjustQuantities', calls: 1, fault: { kind: 'timeout', applied: true } });
    await addRefs(h, variant, loc, ['T-1', 'T-2', 'T-3']);
    await h.drain();
    expect(sim_level(h, item, loc).available).toBe(3);
    const writes = h.sim.requests.filter((r) => r.operations.includes('inventoryAdjustQuantities'));
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(writes.map((w) => w.idempotencyKey)).size).toBe(1);
    expect(writes.at(-1)!.replay).toBe(true);
    await assertConsistent(h);
  });

  it('CHANGE_FROM_QUANTITY_STALE: new revision with a new key, level re-read and write recomputed', async () => {
    const { h, loc, variant, item } = await setup('ch04b');
    await track(h, [variant]);
    h.sim.faults.add({ operation: 'inventoryAdjustQuantities', calls: 1, fault: { kind: 'staleChange', drift: 2 } });
    await addRefs(h, variant, loc, ['S-1', 'S-2', 'S-3']);
    await h.drain();
    const writes = h.sim.requests.filter((r) => r.operations.includes('inventoryAdjustQuantities'));
    expect(writes).toHaveLength(2);
    expect(writes[0]!.userErrorCodes).toEqual(['CHANGE_FROM_QUANTITY_STALE']);
    expect(writes[0]!.idempotencyKey).not.toBe(writes[1]!.idempotencyKey);
    const row = await h.query<{ revision: number; status: string }>("SELECT revision, status FROM outbox WHERE kind = 'inventory_adjust'");
    expect(row).toEqual([{ revision: 1, status: 'done' }]);
    // The concurrent writer added 2 that the app now sees as already counted: only 1 is written (deficit guard).
    expect(sim_level(h, item, loc).available).toBe(3);
    await assertConsistent(h);
  });

  it('a stale quantity on every attempt for 10 minutes and 3 revisions ends dead with outbox_dead', async () => {
    const { h, loc, variant } = await setup('ch04c');
    await track(h, [variant]);
    // The refusal itself is injected: the level read before each revision stays the same.
    h.sim.faults.add({ operation: 'inventoryAdjustQuantities', calls: { from: 1, to: 1000 }, fault: { kind: 'userError', code: 'CHANGE_FROM_QUANTITY_STALE' } });
    await addRefs(h, variant, loc, ['X-1']);
    for (let i = 0; i < 6; i++) {
      await h.step();
      // Time passes: the revisions started more than 10 minutes ago.
      await h.run('UPDATE outbox SET stale_since = stale_since - 11 * 60000 WHERE stale_since IS NOT NULL');
    }
    const row = await h.query<{ status: string; revision: number }>("SELECT status, revision FROM outbox WHERE kind = 'inventory_adjust'");
    expect(row[0]!.status).toBe('dead');
    expect(row[0]!.revision).toBeGreaterThanOrEqual(3);
    expect(await anomalies(h, 'outbox_dead')).toHaveLength(1);
  });
});

describe('T-CH-08 / T-CH-10 — outage and transient user errors', () => {
  it('5xx and THROTTLED are retried without dead rows; SERVICE_UNAVAILABLE then IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED gives a new revision; applied once', { timeout: 30_000 }, async () => {
    const { h, loc, variant, item } = await setup('ch10');
    await track(h, [variant]);
    h.sim.faults.add({ operation: 'order', calls: 1, fault: { kind: 'throttled' } });
    h.sim.faults.add({ operation: 'inventoryAdjustQuantities', calls: 1, fault: { kind: 'userError', code: 'SERVICE_UNAVAILABLE' } });
    h.sim.faults.add({ operation: 'inventoryAdjustQuantities', calls: { from: 2, to: 3 }, fault: { kind: 'http', status: 503 } });
    await addRefs(h, variant, loc, ['Y-1', 'Y-2']);
    await h.drain();
    h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] });
    await h.drain();
    expect(sim_level(h, item, loc)).toMatchObject({ available: 1, committed: 1 });
    expect(await h.query("SELECT 1 FROM outbox WHERE status IN ('dead', 'failed')")).toEqual([]);
    const writes = h.sim.requests.filter((r) => r.operations.includes('inventoryAdjustQuantities'));
    expect(writes.some((w) => w.errorCodes.includes('IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED') || w.userErrorCodes.includes('IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED'))).toBe(true);
    expect((await h.query<{ revision: number }>("SELECT revision FROM outbox WHERE kind = 'inventory_adjust'"))[0]!.revision).toBe(1);
    expect(await h.query("SELECT 1 FROM allocations WHERE status = 'active'")).toHaveLength(1);
    await assertConsistent(h);
  });
});

describe('T-IDEM-01 / T-IDEM-02 — replays write nothing', () => {
  it('a replayed sync writes nothing; the metafield webhook gives no write; an external change is restored once', async () => {
    const { h, loc, variant } = await setup('idem');
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['I-1', 'I-2']);
    await h.drain();
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 2 }] });
    await h.drain();
    const mutations = () => h.sim.requests.filter((r) => r.mutation).length;
    const events = async () => (await h.query<{ n: number }>('SELECT count(*) AS n FROM unit_events'))[0]!.n;
    expect(h.sim.callCount('metafieldsSet')).toBe(1);
    const before = { m: mutations(), e: await events() };

    // T-IDEM-01: the same sync again, nothing changed in Shopify.
    await h.run("INSERT INTO tasks (key, kind, payload, run_at, deadline_at, status, priority, created_at, updated_at) VALUES (?, 'sync_order', ?, 0, 0, 'pending', 10, 0, 0)", `sync_order:${order.id}`, JSON.stringify({ orderGid: order.id }));
    await h.drain();
    expect(mutations()).toBe(before.m);
    expect(await events()).toBe(before.e);

    // T-IDEM-02: an external tool rewrites the metafield → restored once, then quiet.
    const mf = h.sim.shop.order(order.id).metafields.find((m) => m.key === 'units')!;
    mf.value = JSON.stringify({ version: 1, lines: [] });
    h.sim.shop.touchOrder(h.sim.shop.order(order.id));
    h.sim.shop.emit('orders/updated', { id: Number(order.id.split('/').pop()), admin_graphql_api_id: order.id, line_items: [] });
    await h.drain();
    expect(h.sim.callCount('metafieldsSet')).toBe(2);
    expect(metafieldOf(h, order.id)!.lines[0]!.units).toHaveLength(2);
    await h.drain();
    expect(h.sim.callCount('metafieldsSet')).toBe(2);
    await assertConsistent(h);
  });
});
