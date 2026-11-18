/**
 * Chaos at the Worker level, operations side (spec 18.3: T-CH-05, T-CH-06, T-CH-07, T-CH-09), with
 * the simulator's fault injection. Each scenario checks idempotence (no write applied twice) and the
 * invariants of the base.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { registerTaskHandler } from '../src/handlers.js';
import type { ShopStore } from '../src/shop-store.js';
import { MAX_ATTEMPTS } from '../src/tasks.js';
import { addRefs, anomalies, assertConsistent, createHarness, json, sim_level, track, type Harness } from './e2e-harness.js';

const harnesses: Harness[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.restore();
  while (restores.length) restores.pop()!();
});

async function setup(name: string, opts: Parameters<typeof createHarness>[1] = {}) {
  const h = await createHarness(name, opts);
  harnesses.push(h);
  const loc = h.sim.addLocation('Main');
  const { variantIds, itemIds } = h.sim.addProduct('Bike', [{ sku: 'BIKE', stock: { [loc]: 0 } }]);
  return { h, loc, variant: variantIds[0]!, item: itemIds[0]! };
}

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Holds the outbox task as if another execution were running it (valid lease): writes queued meanwhile set
 * `rerun_requested` and arm no alarm, so the object cannot process them by itself. The returned function
 * makes the task due again (the harness then runs it).
 */
async function holdOutbox(h: Harness): Promise<() => Promise<void>> {
  expect(await h.query("SELECT key FROM tasks WHERE key = 'outbox'")).toEqual([]);
  await h.run(
    "INSERT INTO tasks (key, kind, payload, run_at, deadline_at, status, lease_until, lease_token, priority, created_at, updated_at) VALUES ('outbox', 'process_outbox', '{}', 0, 0, 'running', ?, 'held-by-test', 20, 0, 0)",
    Date.now() + 3_600_000,
  );
  return () => h.run("UPDATE tasks SET status = 'pending', run_at = 0, lease_until = NULL, lease_token = NULL WHERE key = 'outbox' AND lease_token = 'held-by-test'");
}

function adjustWrites(h: Harness) {
  return h.sim.requests.filter((r) => r.operations.includes('inventoryAdjustQuantities'));
}

describe('T-CH-05 — object evicted in the middle of a task', () => {
  it('resumes by lease expiry: the same payload and key are resent, applied once, no allocation lost', { timeout: 30_000 }, async () => {
    const { h, loc, variant, item } = await setup('ch05');
    await track(h, [variant]);
    await h.drain();

    // The first stock write reaches Shopify (applied), then its execution hangs: the object is "evicted".
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = 0;
    const original = h.sim.fetch;
    (h.sim as { fetch: typeof original }).fetch = async (input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      if (body.includes('inventoryAdjustQuantities') && gated === 0) {
        gated += 1;
        await original(input, init);
        await gate;
        throw new TypeError('Network connection lost.');
      }
      return original(input, init);
    };
    restores.push(() => ((h.sim as { fetch: typeof original }).fetch = original));

    // Held so that the execution interrupted below is `first`, never the object's own alarm armed by the API call.
    const releaseOutbox = await holdOutbox(h);
    await addRefs(h, variant, loc, ['E-1', 'E-2']);
    await releaseOutbox();
    const first = h.step();
    await waitFor(() => gated === 1);
    expect(await h.query("SELECT status FROM outbox WHERE kind = 'inventory_adjust'")).toEqual([{ status: 'in_flight' }]);

    // Restart: leases have expired, a new execution takes the work over.
    await h.run("UPDATE outbox SET lease_until = 1 WHERE status = 'in_flight'");
    await h.run("UPDATE tasks SET lease_until = 1 WHERE status = 'running'");
    await runInDurableObject(h.stub, (store: ShopStore) => store.alarm());
    expect(await h.query("SELECT status FROM outbox WHERE kind = 'inventory_adjust'")).toEqual([{ status: 'done' }]);

    // The interrupted execution wakes up: its lease is gone, it changes nothing.
    release();
    await first;
    const writes = adjustWrites(h);
    expect(new Set(writes.map((w) => w.idempotencyKey)).size).toBe(1);
    expect(writes.at(-1)!.replay).toBe(true);
    expect(sim_level(h, item, loc).available).toBe(2);
    expect(await h.query("SELECT status FROM outbox WHERE kind = 'inventory_adjust'")).toEqual([{ status: 'done' }]);
    expect(await h.query("SELECT key FROM tasks WHERE status = 'running'")).toEqual([]);

    // Allocation flow afterwards: nothing lost.
    h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] });
    await h.drain();
    expect(await h.query("SELECT count(*) AS n FROM allocations WHERE status = 'active'")).toEqual([{ n: 1 }]);
    await assertConsistent(h);
  });
});

describe('T-CH-06 — a task failing at every run, then a task killed by the platform', () => {
  it('only that task goes dead with task_dead; the alarm is never abandoned and other tasks go on', { timeout: 30_000 }, async () => {
    const { h, loc, variant } = await setup('ch06');
    let thrown = 0;
    let killedRuns = 0;
    restores.push(
      registerTaskHandler('chaos_throw', () => {
        thrown += 1;
        throw new Error('always failing');
      }),
    );
    restores.push(
      registerTaskHandler('chaos_kill', () => {
        killedRuns += 1;
      }),
    );
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['K-1', 'K-2']);
    await h.drain();
    await h.stub.enqueueTask({ key: 'chaos:throw', kind: 'chaos_throw', priority: 30 });

    // An hour of failures: each retry is made due and run; the other work of the shop goes on meanwhile.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await h.run("UPDATE tasks SET run_at = ? WHERE key = 'chaos:throw' AND status = 'pending'", Date.now());
      if (i === 3) h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] });
      await h.deliver();
      await h.step();
    }
    expect(thrown).toBe(MAX_ATTEMPTS);
    expect(await h.query("SELECT status, attempts FROM tasks WHERE key = 'chaos:throw'")).toEqual([{ status: 'dead', attempts: MAX_ATTEMPTS }]);
    expect((await anomalies(h, 'task_dead')).map((a) => a.severity)).toEqual(['critical']);
    await h.drain();
    expect(await h.query("SELECT count(*) AS n FROM allocations WHERE status = 'active'")).toEqual([{ n: 1 }]);

    // A task killed by the CPU limit at every attempt (uncatchable): attempts are counted at take time,
    // the lease expires, the restart recovers it... until the maximum, where it goes dead instead of looping.
    await h.stub.enqueueTask({ key: 'chaos:kill', kind: 'chaos_kill', priority: 30, delayMs: 3_600_000 });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await h.run("UPDATE tasks SET status = 'running', attempts = attempts + 1, lease_until = 1, lease_token = 'killed' WHERE key = 'chaos:kill'");
      await runInDurableObject(h.stub, (store: ShopStore) => (store as unknown as { tasks: { recoverExpiredLeases(): number } }).tasks.recoverExpiredLeases());
    }
    expect(await h.query("SELECT status FROM tasks WHERE key = 'chaos:kill'")).toEqual([{ status: 'dead' }]);
    expect(killedRuns).toBe(0);
    expect(await anomalies(h, 'task_dead')).toHaveLength(2);

    // The alarm is still armed (maintenance, passes) and the shop keeps working.
    await runInDurableObject(h.stub, async (_s: ShopStore, state: DurableObjectState) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] });
    await h.drain();
    expect(await h.query("SELECT count(*) AS n FROM allocations WHERE status = 'active'")).toEqual([{ n: 2 }]);
    const home = await json(await h.api('GET', '/stats/home'), 200);
    expect(home.health.counters.tasksDead).toBe(2);
    expect(home.health.alerts).toContain('task_dead');
    await assertConsistent(h);
  });
});

describe('T-CH-07 — response of a token refresh lost', () => {
  it('retries with the old refresh token: tokens valid, no reconnection asked, write applied once', { timeout: 30_000 }, async () => {
    const { h, loc, variant, item } = await setup('ch07', { sim: { enforceAuth: true } });
    await track(h, [variant]);
    await h.drain();
    // Refs received: the stock write waits in the outbox. It is held there explicitly: the API call arms the
    // object's alarm for "now", and the object would otherwise run the outbox by itself, before or in the middle
    // of the setup below (workers/DECISIONS.md, 68).
    const releaseOutbox = await holdOutbox(h);
    await addRefs(h, variant, loc, ['O-1', 'O-2']);
    expect(await h.query('SELECT status FROM outbox')).toEqual([{ status: 'pending' }]);
    // The access token expires; the next refresh (by the outbox) is applied by Shopify but its response is lost.
    h.sim.oauth.expireAccessTokens();
    await h.run('UPDATE shopify_token SET access_expires_at = ?', Date.now() - 1);
    const issuedBefore = h.sim.oauth.issued;
    const mark = h.sim.requests.length;
    h.sim.faults.add({ operation: 'oauth', calls: h.sim.callCount('oauth') + 1, fault: { kind: 'timeout', applied: true } });

    await releaseOutbox();
    await h.drain();

    // The refreshes were made for the outbox write, before it was sent.
    const after = h.sim.requests.slice(mark);
    expect(after.slice(0, 2).map((r) => r.kind)).toEqual(['oauth', 'oauth']);
    expect(after.findIndex((r) => r.operations.includes('inventoryAdjustQuantities'))).toBeGreaterThan(1);
    expect((await h.stub.status()).token).toBe('valid');
    expect(await anomalies(h, 'reconnect_required')).toEqual([]);
    // Two grants issued by the refresh grant: the lost one, then the retry with the same (old) refresh token.
    expect(h.sim.oauth.issued - issuedBefore).toBe(2);
    expect(sim_level(h, item, loc).available).toBe(2);
    expect(new Set(adjustWrites(h).map((w) => w.idempotencyKey)).size).toBe(1);
    expect(await h.query("SELECT status FROM outbox WHERE status IN ('dead', 'failed')")).toEqual([]);
    await assertConsistent(h);
  });
});

describe('T-CH-09 — shop frozen by Shopify (402) for 10 days', () => {
  it('no dead task, no operations alert, one probe a day; when lifted: full reconciliation, then writes resume', { timeout: 60_000 }, async () => {
    const { h, loc, variant } = await setup('ch09');
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['Z-1', 'Z-2']);
    await h.drain();

    const lift = h.sim.faults.add({ operation: '*', fault: { kind: 'http', status: 402 } });
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] });
    await h.deliver();
    await h.step();
    expect((await h.stub.status()).shopState).toBe('frozen');
    const registry = await env.REGISTRY.prepare('SELECT status FROM shops WHERE shop_domain = ?').bind(h.shop).first<{ status: string }>();
    expect(registry?.status).toBe('frozen');
    const [probe] = await h.query<{ run_at: number }>("SELECT run_at FROM tasks WHERE key = 'freeze_probe'");
    expect(probe!.run_at).toBeGreaterThan(Date.now() + 23 * 3_600_000);

    // Ten days: the alarm only runs the daily probe; every other task waits without counting attempts.
    const probesBefore = h.sim.callCount('shop');
    for (let day = 0; day < 10; day++) {
      await h.run("UPDATE tasks SET run_at = ? WHERE key = 'freeze_probe'", Date.now());
      await h.run('UPDATE tasks SET run_at = ? WHERE status = ? AND key <> ?', Date.now(), 'pending', 'freeze_probe');
      await runInDurableObject(h.stub, async (_s: ShopStore, state: DurableObjectState) => state.storage.setAlarm(Date.now() + 60_000));
      await runDurableObjectAlarm(h.stub);
    }
    expect(h.sim.callCount('shop') - probesBefore).toBe(10);
    expect(await h.query("SELECT key FROM tasks WHERE status = 'dead'")).toEqual([]);
    expect(await h.query("SELECT id FROM outbox WHERE status IN ('dead', 'failed')")).toEqual([]);
    expect((await anomalies(h)).filter((a) => a.severity === 'critical')).toEqual([]);
    const health = await json(await h.api('GET', '/health'), 200);
    expect(health.alerts).toEqual(['frozen']);
    expect(await h.query("SELECT count(*) AS n FROM allocations WHERE status = 'active'")).toEqual([{ n: 0 }]);

    // Lifted: the next probe succeeds, the shop is active, the reconciliation runs before any write.
    lift();
    const mark = h.sim.requests.length;
    await h.run("UPDATE tasks SET run_at = ? WHERE key = 'freeze_probe'", Date.now());
    await runInDurableObject(h.stub, async (_s: ShopStore, state: DurableObjectState) => state.storage.setAlarm(Date.now() + 60_000));
    await runDurableObjectAlarm(h.stub);
    expect((await h.stub.status()).shopState).toBe('active');
    expect((await env.REGISTRY.prepare('SELECT status FROM shops WHERE shop_domain = ?').bind(h.shop).first<{ status: string }>())?.status).toBe('active');
    await h.drain();
    await h.drain();

    expect(await h.query("SELECT count(*) AS n FROM allocations WHERE status = 'active' AND order_gid = ?", order.id)).toEqual([{ n: 1 }]);
    const after = h.sim.requests.slice(mark);
    const firstList = after.findIndex((r) => r.operations.includes('orders'));
    const firstWrite = after.findIndex((r) => r.mutation && r.kind === 'graphql');
    expect(firstList).toBeGreaterThanOrEqual(0);
    expect(firstWrite).toBeGreaterThan(firstList);
    expect(h.sim.callCount('metafieldsSet')).toBe(1);
    expect(await h.query("SELECT 1 FROM meta WHERE key = 'writes_resume_after'")).toEqual([]);
    expect(await h.query("SELECT key FROM tasks WHERE status = 'dead'")).toEqual([]);
    await assertConsistent(h);
  });
});
