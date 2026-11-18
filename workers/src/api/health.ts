/**
 * Health of the shop (spec 17.1, 17.2) for the beta, without external service: counters of dead tasks,
 * dead or stuck outbox rows and token state, shown as banners on the home screen (`GET /stats/home`)
 * and in the admin health section (`GET /health`). Thresholds of 17.2: a task due for more than 2 min,
 * a `dead` task or row, a row waiting for more than 1 h.
 */
import type { HealthAlert, HealthCounters, HealthResponse } from '@serialis/contract';
import type { DomainContext } from '../domain/context.js';
import { iso, json, noContent, problem, type ApiResult } from './http.js';
import { logEvent } from '../log.js';
import type { ApiContext } from './present.js';
import type { StoredPayload } from '../outbox.js';
import { requestLevelCheck, requestOrderSync } from '../domain/sync-order.js';
import type { MetafieldIntent, StockIntent } from '../domain/writes.js';

export const TASK_OVERDUE_MS = 2 * 60_000;
export const OUTBOX_STUCK_MS = 3_600_000;

export interface HealthInfo {
  tokenStatus: string;
  shopState: string | null;
}

function count(d: DomainContext, query: string, ...binds: SqlStorageValue[]): number {
  return Number(d.sql.exec(query, ...binds).one().n ?? 0);
}

export function healthCounters(d: DomainContext, info: HealthInfo, now: number): { counters: HealthCounters; alerts: HealthAlert[] } {
  const oldest = d.sql.exec<{ at: number | null }>("SELECT MIN(created_at) AS at FROM outbox WHERE status IN ('pending', 'in_flight')").one().at;
  const counters: HealthCounters = {
    tasksDead: count(d, "SELECT count(*) AS n FROM tasks WHERE status = 'dead'"),
    tasksOverdue: count(d, "SELECT count(*) AS n FROM tasks WHERE status = 'pending' AND run_at < ?", now - TASK_OVERDUE_MS),
    outboxDead: count(d, "SELECT count(*) AS n FROM outbox WHERE status = 'dead'"),
    outboxPending: count(d, "SELECT count(*) AS n FROM outbox WHERE status IN ('pending', 'in_flight')"),
    outboxPendingOver1h: count(d, "SELECT count(*) AS n FROM outbox WHERE status IN ('pending', 'in_flight') AND created_at < ?", now - OUTBOX_STUCK_MS),
    outboxOldestPendingSeconds: oldest === null ? null : Math.max(0, Math.round((now - oldest) / 1000)),
    reconnectRequired: info.tokenStatus === 'reconnect_required',
    frozen: info.shopState === 'frozen',
  };
  const alerts: HealthAlert[] = [];
  if (counters.tasksDead > 0) alerts.push('task_dead');
  // A frozen shop suspends its tasks on purpose: no operations alert (12.2, T-CH-09).
  if (counters.tasksOverdue > 0 && !counters.frozen) alerts.push('task_overdue');
  if (counters.outboxDead > 0) alerts.push('outbox_dead');
  if (counters.outboxPendingOver1h > 0 && !counters.frozen) alerts.push('outbox_stuck');
  if (counters.reconnectRequired) alerts.push('reconnect_required');
  if (counters.frozen) alerts.push('frozen');
  if (count(d, "SELECT count(*) AS n FROM anomalies WHERE type = 'webhook_silence' AND status IN ('open', 'acknowledged')") > 0) alerts.push('webhook_silence');
  return { counters, alerts };
}

const PASSES = ['R1', 'R2', 'R3', 'R4', 'purge'] as const;

export function healthReport(ctx: ApiContext, info: HealthInfo): ApiResult {
  const { d, now } = ctx;
  const { counters, alerts } = healthCounters(d, info, now);
  const lastWebhook = d.sql.exec<{ at: string | null }>('SELECT MAX(received_at) AS at FROM inbox').one().at;
  let databaseBytes: number | null = null;
  try {
    databaseBytes = d.sql.databaseSize;
  } catch {
    databaseBytes = null;
  }
  const body: HealthResponse = {
    shopState: (info.shopState as HealthResponse['shopState'] | null) ?? 'active',
    token: info.tokenStatus as HealthResponse['token'],
    schemaVersion: Number(d.repo.meta('schema_version') ?? '0'),
    databaseBytes,
    counters,
    alerts,
    lastWebhookAt: lastWebhook,
    passes: PASSES.map((pass) => {
      const last = d.repo.meta(`last_run:${pass}`);
      const next = d.sql.exec<{ run_at: number }>('SELECT run_at FROM tasks WHERE key = ?', pass === 'purge' ? 'purge' : `recon:${pass}`).toArray()[0];
      return { pass, lastRunAt: last ? iso(Number(last)) : null, nextRunAt: next ? iso(next.run_at) : null };
    }),
    deadTasks: d.sql
      .exec<{ key: string; kind: string; attempts: number; last_error: string | null; updated_at: number }>(
        "SELECT key, kind, attempts, last_error, updated_at FROM tasks WHERE status = 'dead' ORDER BY updated_at DESC LIMIT 50",
      )
      .toArray()
      .map((r) => ({ key: r.key, kind: r.kind, attempts: r.attempts, lastError: r.last_error, updatedAt: new Date(r.updated_at).toISOString() })),
    deadWrites: d.sql
      .exec<{ id: number; kind: string; last_error: string | null; updated_at: number }>("SELECT id, kind, last_error, updated_at FROM outbox WHERE status = 'dead' ORDER BY id DESC LIMIT 50")
      .toArray()
      .map((r) => ({ id: r.id, kind: r.kind, lastError: r.last_error, updatedAt: new Date(r.updated_at).toISOString() })),
  };
  return json(body);
}

// ------------------------------------------------------------------------------------------- actions (12.7)

/**
 * Retrying is pointless while Shopify keeps the shop frozen (12.2) or no usable token exists (13.9):
 * the task or the row would only wait again. 409 so that the screen says why.
 */
function retryBlocked(info: HealthInfo): ApiResult | null {
  if (info.shopState === 'frozen') return problem(409, 'invalid_transition', 'shop_frozen');
  if (info.tokenStatus === 'reconnect_required') return problem(409, 'invalid_transition', 'reconnect_required');
  return null;
}

/** POST /health/tasks/{key}/revive (admin): `task_dead` « relancer depuis l'écran Santé » (12.7). */
export function reviveTask(ctx: ApiContext, info: HealthInfo, key: string): ApiResult {
  const { d, now } = ctx;
  const row = d.sql.exec<{ kind: string; attempts: number; last_error: string | null }>("SELECT kind, attempts, last_error FROM tasks WHERE key = ? AND status = 'dead'", key).toArray()[0];
  if (!row) return problem(404, 'not_found', 'task_not_dead');
  const blocked = retryBlocked(info);
  if (blocked) return blocked;
  const revived = d.storage.transactionSync(() => {
    if (!d.reviveTask(key, now)) return false;
    d.repo.audit(ctx.call.principal.actor, 'task.revive', { key, kind: row.kind, status: 'dead', attempts: row.attempts, lastError: row.last_error }, { key, status: 'pending' }, now);
    return true;
  });
  if (!revived) return problem(404, 'not_found', 'task_not_dead');
  logEvent('info', 'tasks.revived', { task: key, task_kind: row.kind, by: 'operator' });
  return noContent();
}

/** POST /outbox/{id}/retry (admin): `outbox_dead` « Relancer » (12.4, 12.7). */
export function retryWrite(ctx: ApiContext, info: HealthInfo, rawId: string): ApiResult {
  const { d, now } = ctx;
  const id = /^\d{1,15}$/.test(rawId) ? Number(rawId) : NaN;
  const row = Number.isSafeInteger(id)
    ? d.sql.exec<{ kind: string; revision: number; last_error: string | null }>("SELECT kind, revision, last_error FROM outbox WHERE id = ? AND status = 'dead'", id).toArray()[0]
    : undefined;
  if (!row) return problem(404, 'not_found', 'write_not_dead');
  const blocked = retryBlocked(info);
  if (blocked) return blocked;
  const retried = d.storage.transactionSync(() => {
    if (!d.retryOutbox(id, now)) return false;
    d.repo.audit(
      ctx.call.principal.actor,
      'outbox.retry',
      { id, kind: row.kind, status: 'dead', revision: row.revision, lastError: row.last_error },
      { id, status: 'pending', revision: row.revision + 1 },
      now,
    );
    return true;
  });
  if (!retried) return problem(404, 'not_found', 'write_not_dead');
  logEvent('info', 'outbox.retried', { id, kind: row.kind, by: 'operator' });
  return noContent();
}

/** Object reconciled after an abandon (12.4): the level of a stock write, or the order of a metafield write. */
type Reconciliation = { type: 'level'; inventoryItemGid: string; locationId: string } | { type: 'order'; orderGid: string };

function reconciliationOf(payload: StoredPayload): Reconciliation | null {
  const intent = payload.intent as (Partial<StockIntent> & Partial<MetafieldIntent> & { type?: string }) | undefined;
  if (intent?.type === 'stock' && intent.inventoryItemGid && intent.locationId) return { type: 'level', inventoryItemGid: intent.inventoryItemGid, locationId: intent.locationId };
  if (intent?.type === 'metafield' && intent.orderGid) return { type: 'order', orderGid: intent.orderGid };
  return null;
}

function requestReconciliation(d: DomainContext, r: Reconciliation, now: number): void {
  // Due at once: the level check itself waits while the app's own writes on the level are in flight
  // (rows behind the abandoned one), then compares units and Shopify (I1 to I3) and corrects or opens
  // the anomaly; the order sync recomputes the metafield and writes it again if needed.
  if (r.type === 'level') requestLevelCheck(d, r.inventoryItemGid, r.locationId, 0, now);
  else requestOrderSync(d, r.orderGid, 0, now);
}

/**
 * POST /outbox/{id}/abandon (admin): `outbox_dead` « abandonner » (12.4, 12.7). The `dead` row becomes
 * final without being sent (`failed` + `abandoned_at`), the rows behind it on its serial key run again,
 * the object it targeted is reconciled (level check of the item and location, or order sync for the
 * metafield; also for a row that depended on it), its `outbox_dead` anomaly is resolved and the action
 * journaled. Same 403 / 404 (`write_not_dead`) / 409 answers as the retry: the reconciliation promised
 * by 12.4 cannot run while the shop is frozen or without Shopify access.
 */
export function abandonWrite(ctx: ApiContext, info: HealthInfo, rawId: string): ApiResult {
  const { d, now } = ctx;
  const id = /^\d{1,15}$/.test(rawId) ? Number(rawId) : NaN;
  const exists = Number.isSafeInteger(id) && d.sql.exec("SELECT 1 FROM outbox WHERE id = ? AND status = 'dead'", id).toArray().length > 0;
  if (!exists) return problem(404, 'not_found', 'write_not_dead');
  const blocked = retryBlocked(info);
  if (blocked) return blocked;
  const actor = ctx.call.principal.actor;
  const outcome = d.storage.transactionSync(() => {
    const row = d.abandonOutbox(id, actor.id ?? null, now);
    if (!row) return null;
    const reconciliations: Reconciliation[] = [];
    const own = reconciliationOf(row.payload);
    if (own) reconciliations.push(own);
    // A row that depended on it will be failed by the executor (12.4 two-step writes): its object too.
    for (const dep of d.sql.exec<{ payload: string }>("SELECT payload FROM outbox WHERE depends_on = ? AND status = 'pending'", id).toArray()) {
      const r = reconciliationOf(JSON.parse(dep.payload) as StoredPayload);
      if (r && !reconciliations.some((x) => JSON.stringify(x) === JSON.stringify(r))) reconciliations.push(r);
    }
    for (const r of reconciliations) requestReconciliation(d, r, now);
    const live = d.repo.liveAnomalyByKey(`outbox_dead|outbox=${id}`);
    if (live) d.repo.closeAnomaly(live.id, 'resolved', { action: 'abandon', by: actor.id ?? null }, now);
    d.repo.audit(
      actor,
      'outbox.abandon',
      { id, kind: row.kind, status: 'dead', revision: row.revision, lastError: row.last_error },
      { id, status: 'failed', abandoned: true, reconciliation: reconciliations },
      now,
    );
    return { row, reconciliations };
  });
  if (!outcome) return problem(404, 'not_found', 'write_not_dead');
  logEvent('info', 'outbox.abandoned_by_operator', { id, kind: outcome.row.kind, reconciliations: outcome.reconciliations.length });
  return noContent();
}
