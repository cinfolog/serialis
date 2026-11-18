/**
 * Reconciliation passes of the MVP (spec 12.5), self-scheduled in `tasks`:
 *  - R1 (2 min with recent activity, 10 min otherwise): orders updated since the cursor minus
 *    10 min of overlap, synchronized when they touch a tracked variant;
 *  - R2 (15 min): orders still `short`/`error` or with waiting lines, dead order tasks revived
 *    at most once an hour;
 *  - R3 (40 min + jitter): every known level of every tracked item re-checked. MVP: one level read
 *    per pair instead of the bulk export (workers/DECISIONS.md).
 */
import { TASK_PRIORITY } from '../task-kinds.js';
import type { TaskResult } from '../tasks.js';
import type { DomainContext } from './context.js';
import { listOrders } from './shopify-read.js';
import { requestLevelCheck, requestOrderSync, syncOrderTaskKey } from './sync-order.js';
import { runR4 } from './maintenance.js';

const MIN = 60_000;
export const R1_ACTIVE_MS = 2 * MIN;
export const R1_IDLE_MS = 10 * MIN;
export const R1_OVERLAP_MS = 10 * MIN;
export const R2_MS = 15 * MIN;
export const R3_MS = 40 * MIN;

export type Pass = 'R1' | 'R2' | 'R3' | 'R4';

/** Schedules the passes that are not scheduled yet (called when tracking starts and at installation). */
export function ensureReconciliation(ctx: DomainContext, now = Date.now()): void {
  const delays: Record<Exclude<Pass, 'R4'>, number> = { R1: R1_ACTIVE_MS, R2: R2_MS, R3: R3_MS };
  for (const pass of ['R1', 'R2', 'R3'] as const) {
    const key = `recon:${pass}`;
    if (ctx.sql.exec('SELECT 1 FROM tasks WHERE key = ?', key).toArray().length > 0) continue;
    ctx.enqueueTask({ key, kind: 'reconcile', priority: TASK_PRIORITY.reconcile, payload: { pass }, delayMs: delays[pass] }, now);
  }
}

export async function runReconcile(ctx: DomainContext, pass: Pass): Promise<TaskResult> {
  // R4 audits the base itself (outbox, tasks, consistency): it runs even with nothing tracked.
  if (pass === 'R4') return runR4(ctx);
  if (!ctx.repo.hasActiveItems()) return; // nothing tracked: the passes stop until tracking starts again
  let result: TaskResult;
  switch (pass) {
    case 'R1':
      result = await runR1(ctx);
      break;
    case 'R2':
      result = runR2(ctx);
      break;
    case 'R3':
      result = runR3(ctx);
      break;
  }
  ctx.repo.setMeta(`last_run:${pass}`, String(Date.now()));
  return result;
}

async function runR1(ctx: DomainContext): Promise<TaskResult> {
  const { repo, sql } = ctx;
  const started = Date.now();
  const cursor = Number(repo.meta('r1_cursor') ?? String(started - 60 * MIN));
  const since = new Date(cursor - R1_OVERLAP_MS).toISOString();
  const { orders, complete } = await listOrders(ctx.client(), `updated_at:>='${since}'`);
  const tracked = new Set(repo.activeItems().map((i) => i.variantGid));
  const now = Date.now();
  let scheduled = 0;
  ctx.storage.transactionSync(() => {
    for (const o of orders) {
      const known = sql.exec<{ has_tracked_lines: number; shopify_updated_at: number | null }>('SELECT has_tracked_lines, shopify_updated_at FROM order_sync WHERE order_gid = ?', o.orderGid).toArray()[0];
      // Already synchronized from this very version: nothing missed.
      if (known && known.shopify_updated_at !== null && known.shopify_updated_at >= o.updatedAt) continue;
      const touches = o.lines.some((l) => l.variantGid !== null && tracked.has(l.variantGid)) || known?.has_tracked_lines === 1;
      if (!touches) continue;
      requestOrderSync(ctx, o.orderGid, 0, now);
      scheduled += 1;
    }
    const maxSeen = orders.reduce((m, o) => Math.max(m, o.updatedAt), cursor);
    repo.setMeta('r1_cursor', String(complete ? started : maxSeen));
    repo.setMeta('last_reconciliation_at', String(now));
  });
  const lastActivity = Number(repo.meta('last_activity_at') ?? '0');
  return { rescheduleAt: now + (now - lastActivity < 60 * MIN ? R1_ACTIVE_MS : R1_IDLE_MS) };
}

function runR2(ctx: DomainContext): TaskResult {
  const { sql, repo } = ctx;
  const now = Date.now();
  ctx.storage.transactionSync(() => {
    const orders = new Set<string>();
    for (const r of sql.exec<{ order_gid: string }>("SELECT order_gid FROM order_sync WHERE status IN ('pending', 'short', 'error')").toArray()) orders.add(r.order_gid);
    for (const r of sql.exec<{ order_gid: string }>('SELECT DISTINCT order_gid FROM uncovered_lines').toArray()) orders.add(r.order_gid);
    const lastRevive = Number(repo.meta('r2_last_revive') ?? '0');
    const revive = now - lastRevive >= 60 * MIN;
    for (const orderGid of orders) {
      const task = sql.exec<{ status: string }>('SELECT status FROM tasks WHERE key = ?', syncOrderTaskKey(orderGid)).toArray()[0];
      if (task?.status === 'dead') {
        if (revive) {
          sql.exec("UPDATE tasks SET status = 'pending', attempts = 0, run_at = ?, last_error = NULL, updated_at = ? WHERE key = ? AND status = 'dead'", now, now, syncOrderTaskKey(orderGid));
        }
        continue;
      }
      requestOrderSync(ctx, orderGid, 0, now);
    }
    if (revive) repo.setMeta('r2_last_revive', String(now));
    repo.setMeta('last_reconciliation_at', String(now));
  });
  return { rescheduleAt: now + R2_MS };
}

function runR3(ctx: DomainContext): TaskResult {
  const { repo, sql } = ctx;
  const now = Date.now();
  ctx.storage.transactionSync(() => {
    for (const item of repo.activeItems()) {
      const locations = new Set(repo.levelsOfItem(item.id).map((l) => l.locationId));
      for (const r of sql.exec<{ location_id: string }>('SELECT DISTINCT location_id FROM units WHERE tracked_item_id = ? AND location_id IS NOT NULL', item.id).toArray()) {
        locations.add(r.location_id);
      }
      for (const loc of locations) requestLevelCheck(ctx, item.inventoryItemGid, loc, 0, now);
    }
    repo.setMeta('last_reconciliation_at', String(now));
  });
  return { rescheduleAt: now + R3_MS + Math.floor(Math.random() * 2 * MIN) };
}
