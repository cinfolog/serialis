/**
 * End-of-transaction check of the allocation ↔ unit rule (spec 11.2, workers/DECISIONS.md 59): a plan
 * application that would leave an inconsistent unit is rolled back as a whole and opens the critical
 * anomaly `consistency_violation`; the next consistent synchronization closes it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { addRefs, anomalies, createHarness, track, type Harness } from './e2e-harness.js';

const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.restore();
});

async function resync(h: Harness, orderGid: string) {
  await h.run(
    "INSERT INTO tasks (key, kind, payload, run_at, deadline_at, status, priority, created_at, updated_at) VALUES (?, 'sync_order', ?, ?, ?, 'pending', 10, 0, 0) ON CONFLICT (key) DO UPDATE SET run_at = excluded.run_at, status = 'pending'",
    `sync_order:${orderGid}`,
    JSON.stringify({ orderGid }),
    Date.now(),
    Date.now(),
  );
  await h.drain();
}

describe('plan application: end-of-transaction consistency (11.2)', () => {
  it('rolls back an inconsistent result, opens consistency_violation, closes it once consistent again', { timeout: 30_000 }, async () => {
    const h = await createHarness('consistency');
    harnesses.push(h);
    const loc = h.sim.addLocation('Main');
    const { variantIds } = h.sim.addProduct('Bike', [{ sku: 'BIKE', stock: { [loc]: 0 } }]);
    const variant = variantIds[0]!;
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['C-1', 'C-2']);
    await h.drain();
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] });
    await h.drain();
    const [alloc] = await h.query<{ unit_id: string }>("SELECT unit_id FROM allocations WHERE status = 'active'");
    // A code defect is simulated: the unit moves to SHIPPED without its allocation (allowed transition, wrong pair).
    await h.run("UPDATE units SET status = 'SHIPPED', version = version + 1 WHERE id = ?", alloc!.unit_id);
    // Shopify changed meanwhile: a second unit is wanted, so the plan writes something.
    order.edit().addLine({ variantId: variant, quantity: 1 }).commit();
    const before = {
      allocations: await h.query('SELECT id, status FROM allocations ORDER BY id'),
      events: await h.query('SELECT count(*) AS n FROM unit_events'),
    };
    await resync(h, order.id);

    const live = await anomalies(h, 'consistency_violation');
    expect(live).toHaveLength(1);
    expect(live[0]!.severity).toBe('critical');
    expect(JSON.parse(live[0]!.details)).toMatchObject({ units: [alloc!.unit_id], rule: ['SHIPPED:shipped_with_active'] });
    // Nothing of the plan was kept.
    expect(await h.query('SELECT id, status FROM allocations ORDER BY id')).toEqual(before.allocations);
    expect(await h.query('SELECT count(*) AS n FROM unit_events')).toEqual(before.events);
    expect(await h.query("SELECT status, last_error FROM order_sync WHERE order_gid = ?", order.id)).toEqual([{ status: 'error', last_error: 'consistency_violation' }]);

    // Repaired: the next synchronization applies and closes the anomaly.
    await h.run("UPDATE units SET status = 'ALLOCATED', version = version + 1 WHERE id = ?", alloc!.unit_id);
    await resync(h, order.id);
    expect(await anomalies(h, 'consistency_violation')).toHaveLength(0);
    expect(await h.query("SELECT count(*) AS n FROM allocations WHERE status = 'active'")).toEqual([{ n: 2 }]);
  });
});
