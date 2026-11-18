/**
 * Health screen actions (spec 12.7: `task_dead` « relancer depuis l'écran Santé », `outbox_dead`
 * « Relancer »; 12.2, 12.4, 15.8): revive a dead task, retry a dead outbox row, administrators only,
 * journaled, anomalies closed once the work succeeds.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { registerTaskHandler } from '../src/handlers.js';
import { addRefs, anomalies, createHarness, json, sim_level, track, type Harness } from './e2e-harness.js';
import { sessionToken } from './helpers.js';

const harnesses: Harness[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.restore();
  while (restores.length) restores.pop()!();
});

async function setup(name: string) {
  const h = await createHarness(name);
  harnesses.push(h);
  const loc = h.sim.addLocation('Main');
  const { variantIds, itemIds } = h.sim.addProduct('Bike', [{ sku: 'BIKE', stock: { [loc]: 0 } }]);
  // The first user seen is the owner and administrator (15.8).
  await h.api('GET', '/me');
  return { h, loc, variant: variantIds[0]!, item: itemIds[0]! };
}

const KEY = 'health_test:gid://shopify/Order/42';
const revivePath = (key: string) => `/health/tasks/${encodeURIComponent(key)}/revive`;

/** A task of a kind without handler dies at its first run (12.2), with its task_dead anomaly. */
async function deadTask(h: Harness): Promise<void> {
  await h.stub.enqueueTask({ key: KEY, kind: 'health_test', priority: 30 });
  await h.step();
  expect(await h.query('SELECT status FROM tasks WHERE key = ?', KEY)).toEqual([{ status: 'dead' }]);
  expect(await anomalies(h, 'task_dead')).toHaveLength(1);
}

/** A stock write refused with IDEMPOTENCY_KEY_PARAMETER_MISMATCH goes dead (12.4), with its outbox_dead anomaly. */
async function deadWrite(h: Harness, variant: string, loc: string): Promise<number> {
  await track(h, [variant]);
  await h.drain();
  h.sim.faults.add({ operation: 'inventoryAdjustQuantities', times: 1, fault: { kind: 'userError', code: 'IDEMPOTENCY_KEY_PARAMETER_MISMATCH' } });
  await addRefs(h, variant, loc, ['H-1', 'H-2']);
  await h.drain();
  const [row] = await h.query<{ id: number }>("SELECT id FROM outbox WHERE status = 'dead'");
  expect(row).toBeDefined();
  expect(await anomalies(h, 'outbox_dead')).toHaveLength(1);
  return row!.id;
}

describe('POST /health/tasks/{key}/revive (12.7 task_dead)', () => {
  it('puts the dead task back to pending, it runs, its anomaly closes, the action is journaled', async () => {
    const { h } = await setup('revive-task');
    await deadTask(h);
    let runs = 0;
    restores.push(
      registerTaskHandler('health_test', () => {
        runs += 1;
      }),
    );

    const res = await h.api('POST', revivePath(KEY), {});
    expect(res.status).toBe(204);
    // Due at once: the object's own alarm may already have run it (workers/DECISIONS.md, 68), so it is pending or gone.
    const rows = await h.query<{ status: string; attempts: number }>('SELECT status, attempts FROM tasks WHERE key = ?', KEY);
    expect(rows.every((r) => r.status !== 'dead')).toBe(true);
    const health = await json(await h.api('GET', '/health'), 200);
    expect(health.deadTasks).toEqual([]);

    await h.drain();
    expect(runs).toBe(1);
    expect(await h.query('SELECT key FROM tasks WHERE key = ?', KEY)).toEqual([]);
    expect(await anomalies(h, 'task_dead')).toEqual([]);
    const audit = await h.query<{ actor_type: string; action: string; before: string; after: string }>("SELECT actor_type, action, before, after FROM audit_log WHERE action = 'task.revive'");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_type).toBe('user');
    expect(JSON.parse(audit[0]!.before)).toMatchObject({ key: KEY, status: 'dead', attempts: 1 });
    expect(JSON.parse(audit[0]!.after)).toEqual({ key: KEY, status: 'pending' });

    // Not dead any more: 404.
    expect(await json(await h.api('POST', revivePath(KEY), {}), 404)).toMatchObject({ code: 'not_found', detail: 'task_not_dead' });
  });
});

describe('POST /health/writes/{id}/retry (12.7 outbox_dead)', () => {
  it('sends the dead write at its next revision, the stock is written once and the anomaly closes', async () => {
    const { h, loc, variant, item } = await setup('retry-write');
    const id = await deadWrite(h, variant, loc);
    expect(sim_level(h, item, loc).available).toBe(0);
    const [before] = await h.query<{ revision: number; idempotency_key: string }>('SELECT revision, idempotency_key FROM outbox WHERE id = ?', id);

    // The outbox task is held as if another execution ran it, so the object's alarm cannot send the row
    // before the assertions below (same pattern as T-CH-07, workers/DECISIONS.md 68).
    expect(await h.query("SELECT key FROM tasks WHERE key = 'outbox'")).toEqual([]);
    await h.run(
      "INSERT INTO tasks (key, kind, payload, run_at, deadline_at, status, lease_until, lease_token, priority, created_at, updated_at) VALUES ('outbox', 'process_outbox', '{}', 0, 0, 'running', ?, 'held-by-test', 20, 0, 0)",
      Date.now() + 3_600_000,
    );
    const res = await h.api('POST', `/health/writes/${id}/retry`, {});
    expect(res.status).toBe(204);
    expect(await h.query("SELECT rerun_requested FROM tasks WHERE key = 'outbox'")).toEqual([{ rerun_requested: 1 }]);
    const [pending] = await h.query<{ status: string; revision: number; idempotency_key: string; attempts: number }>('SELECT status, revision, idempotency_key, attempts FROM outbox WHERE id = ?', id);
    expect(pending).toMatchObject({ status: 'pending', revision: before!.revision + 1, attempts: 0 });
    expect(pending!.idempotency_key).not.toBe(before!.idempotency_key);
    // The anomaly stays open until the write is sent.
    expect(await anomalies(h, 'outbox_dead')).toHaveLength(1);

    await h.run("UPDATE tasks SET status = 'pending', run_at = 0, lease_until = NULL, lease_token = NULL WHERE key = 'outbox' AND lease_token = 'held-by-test'");
    await h.drain();
    expect(await h.query('SELECT status FROM outbox WHERE id = ?', id)).toEqual([{ status: 'done' }]);
    expect(sim_level(h, item, loc).available).toBe(2);
    expect(await anomalies(h, 'outbox_dead')).toEqual([]);
    const [closed] = await anomalies(h, 'outbox_dead', 'all');
    expect(closed).toMatchObject({ status: 'auto_resolved' });
    const health = await json(await h.api('GET', '/health'), 200);
    expect(health.deadWrites).toEqual([]);
    expect(health.alerts).not.toContain('outbox_dead');
    const audit = await h.query<{ action: string; after: string }>("SELECT action, after FROM audit_log WHERE action = 'outbox.retry'");
    expect(audit.map((a) => JSON.parse(a.after))).toEqual([{ id, status: 'pending', revision: before!.revision + 1 }]);

    expect(await json(await h.api('POST', `/health/writes/${id}/retry`, {}), 404)).toMatchObject({ code: 'not_found', detail: 'write_not_dead' });
  });

  it('R4 closes an outbox_dead anomaly whose row is finished', async () => {
    const { h, loc, variant } = await setup('retry-write-r4');
    const id = await deadWrite(h, variant, loc);
    await h.run("UPDATE outbox SET status = 'done', completed_at = ? WHERE id = ?", Date.now(), id);
    await h.run("UPDATE tasks SET run_at = ? WHERE key = 'recon:R4'", Date.now());
    await h.step();
    expect(await anomalies(h, 'outbox_dead')).toEqual([]);
  });
});

describe('health actions: rights and refusals', () => {
  it('403 for an operator, 404 when unknown or not dead, 409 when the shop is frozen or must reconnect', async () => {
    const { h, loc, variant } = await setup('health-actions-guards');
    await deadTask(h);
    const id = await deadWrite(h, variant, loc);

    const op = { Authorization: `Bearer ${await sessionToken(h.shop, { sub: '200' })}` };
    await h.api('GET', '/me', undefined, op);
    for (const res of [await h.api('POST', revivePath(KEY), {}, op), await h.api('POST', `/health/writes/${id}/retry`, {}, op)]) {
      expect(res.status).toBe(403);
      expect(res.headers.get('Content-Type')).toContain('application/problem+json');
      expect(await res.json()).toMatchObject({ code: 'forbidden', detail: 'admin_required' });
    }

    expect(await json(await h.api('POST', revivePath('nope'), {}), 404)).toMatchObject({ detail: 'task_not_dead' });
    expect(await json(await h.api('POST', revivePath('recon:R4'), {}), 404)).toMatchObject({ detail: 'task_not_dead' });
    expect(await json(await h.api('POST', '/health/writes/999999/retry', {}), 404)).toMatchObject({ detail: 'write_not_dead' });
    expect(await json(await h.api('POST', '/health/writes/abc/retry', {}), 404)).toMatchObject({ detail: 'write_not_dead' });

    await h.run("UPDATE meta SET value = 'frozen' WHERE key = 'shop_state'");
    expect(await json(await h.api('POST', revivePath(KEY), {}), 409)).toMatchObject({ code: 'invalid_transition', detail: 'shop_frozen' });
    expect(await json(await h.api('POST', `/health/writes/${id}/retry`, {}), 409)).toMatchObject({ code: 'invalid_transition', detail: 'shop_frozen' });
    await h.run("UPDATE meta SET value = 'active' WHERE key = 'shop_state'");
    await h.run("UPDATE shopify_token SET status = 'reconnect_required'");
    expect(await json(await h.api('POST', revivePath(KEY), {}), 409)).toMatchObject({ detail: 'reconnect_required' });
    expect(await json(await h.api('POST', `/health/writes/${id}/retry`, {}), 409)).toMatchObject({ detail: 'reconnect_required' });

    // Nothing was changed by the refusals.
    expect(await h.query('SELECT status FROM tasks WHERE key = ?', KEY)).toEqual([{ status: 'dead' }]);
    expect(await h.query('SELECT status FROM outbox WHERE id = ?', id)).toEqual([{ status: 'dead' }]);
    expect(await h.query("SELECT action FROM audit_log WHERE action IN ('task.revive', 'outbox.retry')")).toEqual([]);
  });

  it('is not exposed on the public API', async () => {
    const { PUBLIC_ROUTES } = await import('@serialis/contract');
    const routes = Object.values(PUBLIC_ROUTES).map((r) => r.route);
    expect(routes.some((r) => r.includes('/health'))).toBe(false);
  });
});
