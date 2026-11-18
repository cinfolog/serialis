/**
 * Daily maintenance (spec 12.2 "purge", 16.1 retention, 12.5 R4 audit): alarm-driven tasks, batched
 * deletions, dead rows kept until resolved, audit anomalies opened and closed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { addRefs, anomalies, createHarness, json, track, type Harness } from './e2e-harness.js';

const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.restore();
});

const DAY = 86_400_000;

async function setup(name: string) {
  const h = await createHarness(name);
  harnesses.push(h);
  const loc = h.sim.addLocation('Main');
  const { variantIds } = h.sim.addProduct('Bike', [{ sku: 'BIKE', stock: { [loc]: 0 } }]);
  return { h, loc, variant: variantIds[0]! };
}

/** Runs a scheduled maintenance task now, through the object's alarm. */
async function runTask(h: Harness, key: string) {
  await h.run('UPDATE tasks SET run_at = ? WHERE key = ?', Date.now(), key);
  await h.step();
}

async function outboxRow(h: Harness, status: string, completedAt: number | null, createdAt = completedAt ?? Date.now()) {
  await h.run(
    `INSERT INTO outbox (kind, serial_key, payload, idempotency_key, status, next_attempt_at, created_at, updated_at, completed_at)
     VALUES ('metafield_set', 'test', '{"query":""}', ?, ?, 0, ?, ?, ?)`,
    crypto.randomUUID(),
    status,
    createdAt,
    createdAt,
    completedAt,
  );
}

describe('purge (16.1)', () => {
  it('is scheduled at installation and removes what is past its retention, keeping dead rows', async () => {
    const { h } = await setup('purge');
    expect(await h.query("SELECT kind FROM tasks WHERE key IN ('purge', 'recon:R4') ORDER BY key")).toEqual([{ kind: 'purge' }, { kind: 'reconcile' }]);
    const now = Date.now();
    const old = now - 31 * DAY;
    await h.run("INSERT INTO api_idempotency (key, request_hash, status_code, response, expires_at) VALUES ('k-old', 'h', 200, '', ?), ('k-new', 'h', 200, '', ?)", now - 1, now + DAY);
    await h.run(
      "INSERT INTO inbox (webhook_id, topic, received_at, payload, processed_at) VALUES ('w-old', 't', ?, '{}', ?), ('w-new', 't', ?, '{}', ?)",
      new Date(old).toISOString(),
      new Date(old).toISOString(),
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    );
    await outboxRow(h, 'done', old);
    await outboxRow(h, 'failed', old);
    await outboxRow(h, 'dead', null, old);
    await outboxRow(h, 'done', now);
    await h.run("INSERT INTO imports (id, kind, status, created_at, updated_at) VALUES ('i-old', 'units_csv', 'done', ?, ?), ('i-new', 'units_csv', 'done', ?, ?)", old, old, now, now);
    await h.run(
      "INSERT INTO meta (key, value) VALUES ('settings_simulation:a', ?), ('settings_simulation:b', ?)",
      JSON.stringify({ expiresAt: now - 1 }),
      JSON.stringify({ expiresAt: now + 60_000 }),
    );

    await runTask(h, 'purge');

    expect(await h.query('SELECT key FROM api_idempotency')).toEqual([{ key: 'k-new' }]);
    expect(await h.query('SELECT webhook_id FROM inbox')).toEqual([{ webhook_id: 'w-new' }]);
    expect((await h.query<{ status: string }>("SELECT status FROM outbox WHERE serial_key = 'test' ORDER BY id")).map((r) => r.status)).toEqual(['dead', 'done']);
    expect(await h.query('SELECT id FROM imports')).toEqual([{ id: 'i-new' }]);
    expect(await h.query("SELECT key FROM meta WHERE key LIKE 'settings_simulation:%'")).toEqual([{ key: 'settings_simulation:b' }]);
    // Rescheduled for the next day, last run recorded for the health section.
    const [task] = await h.query<{ run_at: number }>("SELECT run_at FROM tasks WHERE key = 'purge'");
    expect(task!.run_at).toBeGreaterThan(Date.now() + DAY - 60_000);
    expect(await h.query("SELECT 1 FROM meta WHERE key = 'last_run:purge'")).toHaveLength(1);
  });

  it('works by batches: a large backlog is removed over several passes without holding the object', async () => {
    const { h } = await setup('purge-batch');
    await h.run(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200) INSERT INTO api_idempotency (key, request_hash, status_code, response, expires_at) SELECT 'k' || i, 'h', 200, '', 1 FROM n",
    );
    await runTask(h, 'purge');
    expect(await h.query('SELECT count(*) AS n FROM api_idempotency')).toEqual([{ n: 0 }]);
  });
});

describe('R4 audit (12.5)', () => {
  it('opens webhook_silence, repairs missing dead-row anomalies, audits the consistency of the whole base, closes them when fixed', { timeout: 30_000 }, async () => {
    const { h, loc, variant } = await setup('r4');
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['R-1', 'R-2']);
    await h.drain();
    h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] });
    await h.drain();

    // No webhook for 7 hours while an order was updated within 6 hours.
    await h.run('UPDATE inbox SET received_at = ?', new Date(Date.now() - 7 * 3_600_000).toISOString());
    // A dead row whose anomaly is missing, a unit moved without its allocation.
    await outboxRow(h, 'dead', null);
    const [free] = await h.query<{ id: string }>("SELECT id FROM units WHERE status = 'AVAILABLE'");
    const [allocated] = await h.query<{ unit_id: string }>("SELECT unit_id FROM allocations WHERE status = 'active'");
    await h.run("UPDATE units SET status = 'SHIPPED', version = version + 1 WHERE id = ?", allocated!.unit_id);

    await runTask(h, 'recon:R4');
    expect((await anomalies(h, 'webhook_silence')).map((a) => a.severity)).toEqual(['critical']);
    expect(await anomalies(h, 'outbox_dead')).toHaveLength(1);
    const audit = await anomalies(h, 'consistency_violation');
    expect(audit.map((a) => JSON.parse(a.subject).unitId)).toEqual([allocated!.unit_id]);
    expect(free).toBeDefined();
    const health = await json(await h.api('GET', '/health'), 200);
    expect(health.alerts).toEqual(expect.arrayContaining(['outbox_dead', 'webhook_silence']));
    expect(health.passes.find((p: { pass: string }) => p.pass === 'R4').lastRunAt).not.toBeNull();
    const home = await json(await h.api('GET', '/stats/home'), 200);
    expect(home.health.counters).toMatchObject({ outboxDead: 1, tasksDead: 0, reconnectRequired: false, frozen: false });
    expect(home.sync.level).toBe('red');

    // Fixed: a webhook arrives, the unit is consistent again.
    await h.run('UPDATE inbox SET received_at = ?', new Date().toISOString());
    await h.run("UPDATE units SET status = 'ALLOCATED', version = version + 1 WHERE id = ?", allocated!.unit_id);
    await runTask(h, 'recon:R4');
    expect(await anomalies(h, 'webhook_silence')).toHaveLength(0);
    expect(await anomalies(h, 'consistency_violation')).toHaveLength(0);
  });
});
