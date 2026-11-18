/**
 * Daily maintenance of a shop object, alarm-driven and batched (spec 12.2 "purge", 12.5 R4, 16.1):
 *  - `purge`: expired idempotency replays (24 h), webhook inbox (30 days), finished outbox rows
 *    (30 days; `dead` rows are kept until resolved), imports (30 days), expired unit locks and
 *    settings simulations. Deletions go by batches of 500 through an index; a pass that hits a full
 *    batch comes back a minute later instead of holding the object.
 *  - R4 audit: webhook silence, dead outbox rows and tasks without their anomaly, allocation ↔ unit
 *    consistency over the whole base (11.2). Expired reservations and overdue transits have no object
 *    in the MVP (workers/DECISIONS.md 60).
 */
import { checkAllocationConsistency, type ConsistencyViolation } from '@serialis/core';
import { logEvent } from '../log.js';
import { TASK_PRIORITY } from '../task-kinds.js';
import type { TaskResult } from '../tasks.js';
import type { DomainContext } from './context.js';
import { parseJson } from './util.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const PURGE_KEY = 'purge';
export const R4_KEY = 'recon:R4';
export const PURGE_EVERY_MS = DAY;
export const R4_EVERY_MS = DAY;
export const RETENTION_MS = 30 * DAY;
const BATCH = 500;
const PURGE_BUDGET_MS = 5_000;
/** R4: a shop with tracked orders updated in Shopify but no webhook for 6 h has a silent subscription (12.5). */
export const WEBHOOK_SILENCE_MS = 6 * 3_600_000;
export const OUTBOX_STUCK_MS = 3_600_000;
const AUDIT_PAGE = 500;

/** Schedules the daily purge and R4 when missing (installation, start of the object). Synchronous. */
export function ensureMaintenance(ctx: Pick<DomainContext, 'sql' | 'enqueueTask'>, now = Date.now()): void {
  const has = (key: string) => ctx.sql.exec('SELECT 1 FROM tasks WHERE key = ?', key).toArray().length > 0;
  if (!has(PURGE_KEY)) ctx.enqueueTask({ key: PURGE_KEY, kind: 'purge', priority: TASK_PRIORITY.purge, delayMs: 60 * MIN }, now);
  if (!has(R4_KEY)) ctx.enqueueTask({ key: R4_KEY, kind: 'reconcile', priority: TASK_PRIORITY.reconcile, payload: { pass: 'R4' }, delayMs: 2 * 60 * MIN }, now);
}

// ------------------------------------------------------------------------------------------- purge (16.1)

interface PurgeStep {
  name: string;
  run(ctx: DomainContext, now: number): number;
}

const STEPS: PurgeStep[] = [
  {
    name: 'api_idempotency',
    run: (ctx, now) => ctx.sql.exec('DELETE FROM api_idempotency WHERE key IN (SELECT key FROM api_idempotency WHERE expires_at < ? LIMIT ?)', now, BATCH).rowsWritten,
  },
  {
    name: 'inbox',
    // `received_at` is ISO text (0001): the lexical order is the time order.
    run: (ctx, now) =>
      ctx.sql.exec(
        'DELETE FROM inbox WHERE webhook_id IN (SELECT webhook_id FROM inbox WHERE received_at < ? AND processed_at IS NOT NULL LIMIT ?)',
        new Date(now - RETENTION_MS).toISOString(),
        BATCH,
      ).rowsWritten,
  },
  {
    name: 'outbox',
    // Finished rows only; a row still referenced by `depends_on` goes after the row that references it.
    run: (ctx, now) =>
      ctx.sql.exec(
        `DELETE FROM outbox WHERE id IN (
           SELECT o.id FROM outbox o WHERE o.status IN ('done', 'failed') AND o.completed_at < ?
             AND NOT EXISTS (SELECT 1 FROM outbox r WHERE r.depends_on = o.id) LIMIT ?)`,
        now - RETENTION_MS,
        BATCH,
      ).rowsWritten,
  },
  {
    name: 'imports',
    run: (ctx, now) => ctx.sql.exec('DELETE FROM imports WHERE id IN (SELECT id FROM imports WHERE created_at < ? LIMIT ?)', now - RETENTION_MS, BATCH).rowsWritten,
  },
  {
    name: 'unit_locks',
    run: (ctx, now) => ctx.sql.exec('DELETE FROM unit_locks WHERE unit_id IN (SELECT unit_id FROM unit_locks WHERE expires_at < ? LIMIT ?)', now, BATCH).rowsWritten,
  },
  {
    name: 'settings_simulations',
    run: (ctx, now) => {
      const expired = ctx.sql
        .exec<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key >= 'settings_simulation:' AND key < 'settings_simulation;' LIMIT ?", BATCH * 4)
        .toArray()
        .filter((r) => (parseJson<{ expiresAt?: number }>(r.value, {}).expiresAt ?? 0) < now)
        .slice(0, BATCH);
      for (const r of expired) ctx.sql.exec('DELETE FROM meta WHERE key = ?', r.key);
      return expired.length;
    },
  },
];

export function runPurge(ctx: DomainContext): TaskResult {
  const started = Date.now();
  const removed: Record<string, number> = {};
  let more = false;
  for (const step of STEPS) {
    let n = 0;
    for (;;) {
      const now = Date.now();
      const deleted = ctx.storage.transactionSync(() => step.run(ctx, now));
      n += deleted;
      if (deleted === 0) break;
      if (Date.now() - started > PURGE_BUDGET_MS) {
        more = true;
        break;
      }
    }
    removed[step.name] = n;
    if (more) break;
  }
  const now = Date.now();
  if (!more) ctx.repo.setMeta('last_run:purge', String(now));
  logEvent('info', 'purge.done', { ...removed, more });
  return { rescheduleAt: more ? now + MIN : now + PURGE_EVERY_MS };
}

// ------------------------------------------------------------------------------------------- R4 audit (12.5)

export interface AuditReport {
  webhookSilence: boolean;
  outboxStuck: number;
  repairedAnomalies: number;
  inconsistentUnits: number;
}

export function runR4(ctx: DomainContext): TaskResult {
  const report = auditShop(ctx, Date.now());
  logEvent(report.inconsistentUnits > 0 || report.webhookSilence ? 'warn' : 'info', 'reconcile.r4', { ...report });
  const now = Date.now();
  ctx.repo.setMeta('last_run:R4', String(now));
  return { rescheduleAt: now + R4_EVERY_MS };
}

export function auditShop(ctx: DomainContext, now: number): AuditReport {
  const { sql, repo } = ctx;
  let repaired = 0;

  // Webhook subscriptions: tracked orders updated in Shopify in the last 6 h (seen by R1) but no delivery.
  const lastWebhook = sql.exec<{ at: string | null }>('SELECT MAX(received_at) AS at FROM inbox').one().at;
  const recentOrders = Number(sql.exec('SELECT count(*) AS n FROM order_sync WHERE has_tracked_lines = 1 AND shopify_updated_at > ?', now - WEBHOOK_SILENCE_MS).one().n);
  const silent = recentOrders > 0 && (lastWebhook === null || Date.parse(lastWebhook) < now - WEBHOOK_SILENCE_MS);
  const silence = repo.liveAnomalyByKey('webhook_silence');
  ctx.storage.transactionSync(() => {
    if (silent) repo.openAnomaly({ type: 'webhook_silence', subject: {}, fingerprintKey: 'webhook_silence', details: { lastWebhookAt: lastWebhook, recentOrders }, now });
    else if (silence) repo.closeAnomaly(silence.id, 'auto_resolved', { by: 'R4' }, now);
  });

  // Dead outbox rows and dead tasks always carry their critical anomaly (repair after a defect or a restore).
  ctx.storage.transactionSync(() => {
    for (const r of sql.exec<{ id: number; kind: string; last_error: string | null }>("SELECT id, kind, last_error FROM outbox WHERE status = 'dead'").toArray()) {
      if (repo.liveAnomalyByKey(`outbox_dead|outbox=${r.id}`)) continue;
      repo.openAnomaly({ type: 'outbox_dead', subject: {}, fingerprintKey: `outbox_dead|outbox=${r.id}`, details: { outboxId: r.id, kind: r.kind, error: r.last_error }, now });
      repaired += 1;
    }
    for (const t of sql.exec<{ key: string; kind: string; attempts: number; last_error: string | null }>("SELECT key, kind, attempts, last_error FROM tasks WHERE status = 'dead'").toArray()) {
      if (repo.liveAnomalyByKey(`task_dead|task=${t.key}`)) continue;
      repo.openAnomaly({ type: 'task_dead', subject: {}, fingerprintKey: `task_dead|task=${t.key}`, details: { task: t.key, kind: t.kind, attempts: t.attempts, error: t.last_error }, now });
      repaired += 1;
    }
    // A task_dead anomaly whose task is no longer dead (revived and finished, or removed) is closed.
    for (const a of sql.exec<{ id: string; details: string }>("SELECT id, details FROM anomalies WHERE type = 'task_dead' AND status IN ('open', 'acknowledged')").toArray()) {
      const key = parseJson<{ task?: string }>(a.details, {}).task;
      const dead = key ? sql.exec("SELECT 1 FROM tasks WHERE key = ? AND status = 'dead'", key).toArray().length > 0 : false;
      if (!dead) repo.closeAnomaly(a.id, 'auto_resolved', { by: 'R4' }, now);
    }
  });
  const outboxStuck = Number(sql.exec("SELECT count(*) AS n FROM outbox WHERE status IN ('pending', 'in_flight') AND created_at < ?", now - OUTBOX_STUCK_MS).one().n);

  // Allocation ↔ unit consistency of the whole base (11.2), by pages of units.
  const inconsistent = new Set<string>();
  let after = '';
  for (;;) {
    const units = sql.exec<{ id: string; status: string }>('SELECT id, status FROM units WHERE id > ? ORDER BY id LIMIT ?', after, AUDIT_PAGE).toArray();
    if (units.length === 0) break;
    after = units[units.length - 1]!.id;
    const first = units[0]!.id;
    const allocations = sql
      .exec<{ id: string; unit_id: string; status: 'active' | 'fulfilled' }>("SELECT id, unit_id, status FROM allocations WHERE unit_id >= ? AND unit_id <= ? AND status IN ('active', 'fulfilled')", first, after)
      .toArray();
    const violations = checkAllocationConsistency(
      units.map((u) => ({ id: u.id, status: u.status as ConsistencyViolation['status'] })),
      allocations.map((a) => ({ id: a.id, unitId: a.unit_id, status: a.status })),
    );
    if (violations.length > 0) {
      ctx.storage.transactionSync(() => {
        for (const v of violations) {
          inconsistent.add(v.unitId);
          repo.openAnomaly({ type: 'consistency_violation', subject: { unitId: v.unitId }, details: { rule: `${v.status}:${v.detail}`, active: v.active, fulfilled: v.fulfilled, source: 'audit_R4' }, now });
        }
      });
    }
    if (units.length < AUDIT_PAGE) break;
  }
  // Audit anomalies of units that are consistent again are closed.
  ctx.storage.transactionSync(() => {
    for (const a of sql.exec<{ id: string; unit_id: string | null }>("SELECT id, unit_id FROM anomalies WHERE type = 'consistency_violation' AND unit_id IS NOT NULL AND status IN ('open', 'acknowledged')").toArray()) {
      if (a.unit_id && !inconsistent.has(a.unit_id)) repo.closeAnomaly(a.id, 'auto_resolved', { by: 'R4' }, now);
    }
  });

  return { webhookSilence: silent, outboxStuck, repairedAnomalies: repaired, inconsistentUnits: inconsistent.size };
}
