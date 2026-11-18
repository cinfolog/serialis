/**
 * Task `sync_order` (spec 12.3): one GraphQL read, then one SQLite transaction that loads the
 * current state, plans with core's `planOrderSync` and applies the plan (allocations first, units
 * next, events, anomalies, uncovered lines, explained quantities), and queues the Shopify writes
 * in the outbox. Replaying it without change in Shopify writes nothing (T-IDEM-01).
 */
import { checkAllocationConsistency, planOrderSync, type ConsistencyViolation, type OrderSnapshot, type ReturnIdentification, type SyncPlan, type SyncState } from '@serialis/core';
import { TASK_PRIORITY } from '../task-kinds.js';
import type { TaskContext, TaskResult } from '../tasks.js';
import { logEvent } from '../log.js';
import type { DomainContext } from './context.js';
import type { Cause } from './repo.js';
import { readOrder, type OrderRead } from './shopify-read.js';
import { hasPendingMetafieldWrite, metafieldWriteInput, stockWriteInput, type StockIntent } from './writes.js';
import { chunks, newId, numericOf, placeholders } from './util.js';

/**
 * Raised inside the transaction of a plan application when the allocation ↔ unit rule of 11.2 does not
 * hold at its end: the whole transaction rolls back (workers/DECISIONS.md 59).
 */
export class ConsistencyError extends Error {
  override readonly name = 'ConsistencyError';
  constructor(readonly violations: readonly ConsistencyViolation[]) {
    super(`allocation/unit consistency violated for ${violations.length} unit(s)`);
  }
}

/** End-of-transaction check of 11.2 on the given units (current rows of the transaction). */
export function assertUnitsConsistent(ctx: Pick<DomainContext, 'sql'>, unitIds: Iterable<string>): void {
  const ids = [...new Set(unitIds)];
  const units: Array<{ id: string; status: string }> = [];
  const allocations: Array<{ id: string; unit_id: string; status: string }> = [];
  for (const part of chunks(ids)) {
    const ph = placeholders(part.length);
    units.push(...ctx.sql.exec<{ id: string; status: string }>(`SELECT id, status FROM units WHERE id IN (${ph})`, ...part).toArray());
    allocations.push(...ctx.sql.exec<{ id: string; unit_id: string; status: string }>(`SELECT id, unit_id, status FROM allocations WHERE unit_id IN (${ph}) AND status IN ('active', 'fulfilled')`, ...part).toArray());
  }
  const violations = checkAllocationConsistency(
    units.map((u) => ({ id: u.id, status: u.status as ConsistencyViolation['status'] })),
    allocations.map((a) => ({ id: a.id, unitId: a.unit_id, status: a.status as 'active' | 'fulfilled' })),
  );
  if (violations.length > 0) throw new ConsistencyError(violations);
}

export function syncOrderTaskKey(orderGid: string): string {
  return `sync_order:${orderGid}`;
}

/** Schedules a synchronization of the order (coalesced with any pending one). */
export function requestOrderSync(ctx: Pick<DomainContext, 'enqueueTask'>, orderGid: string, delayMs = 0, now = Date.now()): void {
  ctx.enqueueTask({ key: syncOrderTaskKey(orderGid), kind: 'sync_order', priority: TASK_PRIORITY.sync_order, payload: { orderGid }, delayMs }, now);
}

export function inventoryLevelTaskKey(inventoryItemGid: string, locationId: string): string {
  return `inv:${numericOf(inventoryItemGid)}:${numericOf(locationId)}`;
}

/** Schedules the check of one level (spec 12.2: `inventory_levels/update`, end of `sync_order`, R3). */
export function requestLevelCheck(ctx: Pick<DomainContext, 'enqueueTask'>, inventoryItemGid: string, locationId: string, delayMs = 5_000, now = Date.now()): void {
  ctx.enqueueTask(
    {
      key: inventoryLevelTaskKey(inventoryItemGid, locationId),
      kind: 'sync_inventory_level',
      priority: TASK_PRIORITY.sync_inventory_level,
      payload: { inventoryItemId: numericOf(inventoryItemGid), locationId: numericOf(locationId) },
      delayMs,
    },
    now,
  );
}

function editsOf(ctx: DomainContext, orderGid: string): OrderSnapshot['edits'] {
  return ctx.sql
    .exec<{ line_item_gid: string; quantity: number; restock: number | null }>(
      'SELECT line_item_gid, quantity, restock FROM order_edit_removals WHERE order_gid = ? ORDER BY received_at, edit_id',
      orderGid,
    )
    .toArray()
    .map((r) => ({ lineItemGid: r.line_item_gid, quantity: r.quantity, restock: r.restock === null ? null : r.restock === 1 }));
}

export async function runSyncOrder(ctx: DomainContext, orderGid: string, task: Pick<TaskContext, 'key' | 'holdsLease'>): Promise<TaskResult> {
  const read = await readOrder(ctx.client(), orderGid, editsOf(ctx, orderGid));
  if (!read) {
    // Deleted, or out of the readable window (L7): nothing to align.
    logEvent('warn', 'sync_order.order_missing', { order: orderGid });
    return;
  }
  const now = Date.now();
  let outcome: ReturnType<typeof applyOrderSync> | null;
  try {
    outcome = ctx.storage.transactionSync(() => {
      if (!task.holdsLease()) return null; // another execution owns the task now (12.2 "Baux")
      return applyOrderSync(ctx, read, now, { type: 'task', id: task.key });
    });
  } catch (error) {
    if (!(error instanceof ConsistencyError)) throw error;
    // Rolled back as a whole: nothing of the plan is kept; a critical anomaly asks for a fix, R2 retries the order.
    recordConsistencyViolation(ctx, orderGid, error, now);
    return;
  }
  if (!outcome) return;
  for (const [item, loc] of outcome.levels) requestLevelCheck(ctx, item, loc);
  if (outcome.plan.rejected.length > 0) {
    logEvent('warn', 'sync_order.rejected_transitions', { order: orderGid, count: outcome.plan.rejected.length });
  }
}

/** Loads the state (12.3 step 4), plans and applies. Synchronous: runs inside the task's transaction. */
export function applyOrderSync(ctx: DomainContext, read: OrderRead, now: number, cause: Cause): { plan: SyncPlan; levels: Array<[string, string]> } {
  const { repo, sql } = ctx;
  const snapshot = read.snapshot;
  const orderGid = snapshot.orderGid;
  const orderAllocations = repo.orderAllocations(orderGid);

  const variantGids = snapshot.lineItems.map((l) => l.variantGid).filter((v): v is string => v !== null);
  const allocatedUnits = repo.unitsByIds(orderAllocations.map((a) => a.unitId));
  const items = new Map(repo.itemsByVariants(variantGids).map((i) => [i.id, i]));
  for (const i of repo.itemsByIds(allocatedUnits.map((u) => u.trackedItemId))) items.set(i.id, i);

  const locations = new Set<string>();
  for (const fo of snapshot.fulfillmentOrders) locations.add(fo.locationId);
  for (const f of snapshot.fulfillments) locations.add(f.locationId);
  for (const r of snapshot.returns) for (const d of r.dispositions) locations.add(d.locationId);
  for (const r of snapshot.refunds) for (const l of r.lineItems) if (l.locationId) locations.add(l.locationId);
  for (const loc of locations) repo.ensureLocation(loc, now);

  const candidates = repo.availableUnits(
    [...items.values()].filter((i) => i.active).map((i) => i.id),
    [...locations],
  );
  const units = new Map(allocatedUnits.map((u) => [u.id, u]));
  for (const u of candidates) units.set(u.id, u);
  const allocations = new Map(orderAllocations.map((a) => [a.id, a]));
  for (const a of repo.engagedAllocationsOf([...units.keys()])) allocations.set(a.id, a);

  const identifications: ReturnIdentification[] = sql
    .exec<{ return_line_item_gid: string; unit_id: string | null; typed_ref: string }>(
      'SELECT return_line_item_gid, unit_id, typed_ref FROM return_identifications WHERE order_gid = ? ORDER BY created_at, id',
      orderGid,
    )
    .toArray()
    .map((r) => ({ returnLineItemGid: r.return_line_item_gid, unitId: r.unit_id, typedRef: r.typed_ref }));

  const state: SyncState = {
    trackedItems: [...items.values()],
    units: [...units.values()],
    allocations: [...allocations.values()],
    anomalies: repo.orderAnomalies(orderGid),
    locks: repo.locks(now),
    preexistingLineItemGids: sql
      .exec<{ line_item_gid: string }>("SELECT line_item_gid FROM order_line_tracking WHERE order_gid = ? AND mode = 'preexisting'", orderGid)
      .toArray()
      .map((r) => r.line_item_gid),
    returnIdentifications: identifications,
    automationPaused: repo.automationPaused(),
  };

  const plan = planOrderSync(snapshot, state, repo.storedSettings(), now, { newId: () => newId(now) });
  const levels = new Map<string, [string, string]>();
  const unitById = new Map(state.units.map((u) => [u.id, u]));
  const itemOf = (unitId: string) => items.get(unitById.get(unitId)?.trackedItemId ?? '');

  // Allocations first (updates before creations: a unit relocated and allocated again in the same pass), then units (11.2).
  for (const up of plan.allocationUpdates) repo.patchAllocation(up.id, up.patch);
  for (const a of plan.allocationsToCreate) repo.insertAllocation(a);
  for (const t of plan.unitTransitions) {
    if (!repo.transitionUnit(t.unitId, t.from, t.to, t.locationId, now)) throw new Error(`unit ${t.unitId} is no longer ${t.from}`);
    repo.insertEvent({
      unitId: t.unitId,
      type: t.event,
      from: t.from,
      to: t.to,
      actor: { type: 'system', id: null },
      cause,
      orderGid,
      locationId: t.locationId,
      data: { ...t.data, ...(t.allocationId ? { allocationId: t.allocationId } : {}) },
      now,
    });
    const item = itemOf(t.unitId);
    if (item && t.locationId) levels.set(`${item.inventoryItemGid}|${t.locationId}`, [item.inventoryItemGid, t.locationId]);
  }

  for (const d of plan.anomaliesToOpen) repo.openAnomaly({ id: d.id, type: d.type, subject: d.subject, details: d.details, fingerprintKey: d.fingerprint, now });
  for (const u of plan.anomaliesToUpdate) repo.updateAnomalyDetails(u.id, u.details, now);
  for (const id of plan.anomaliesToResolve) repo.closeAnomaly(id, 'auto_resolved', { by: 'sync' }, now);

  // Waiting quantity of the order (8): the stored set is replaced, `since` kept per FO line.
  const since = new Map(
    sql
      .exec<{ fo_line_item_gid: string; since: number }>('SELECT fo_line_item_gid, since FROM uncovered_lines WHERE order_gid = ?', orderGid)
      .toArray()
      .map((r) => [r.fo_line_item_gid, r.since]),
  );
  sql.exec('DELETE FROM uncovered_lines WHERE order_gid = ?', orderGid);
  for (const u of plan.uncoveredLines) {
    sql.exec(
      'INSERT INTO uncovered_lines (fo_line_item_gid, order_gid, line_item_gid, fo_gid, tracked_item_id, location_id, quantity, since) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      u.foLineItemGid,
      u.orderGid,
      u.lineItemGid,
      u.foGid,
      u.trackedItemId,
      u.locationId,
      u.quantity,
      since.get(u.foLineItemGid) ?? now,
    );
  }

  applyExplained(ctx, orderGid, plan, now);

  for (const w of plan.stockWrites) {
    const item = [...items.values()].find((i) => i.inventoryItemGid === w.inventoryItemGid);
    if (!item) continue;
    const intent: StockIntent = {
      type: 'stock',
      op: w.kind === 'move' ? 'move' : 'adjust',
      trackedItemId: item.id,
      inventoryItemGid: w.inventoryItemGid,
      locationId: w.locationId,
      name: w.quantityName as StockIntent['name'],
      ...(w.fromQuantityName ? { fromName: w.fromQuantityName as StockIntent['name'] } : {}),
      delta: w.delta,
      guard: 'none',
      reason: w.reason === 'return_processing_required' ? 'quality_control' : 'correction',
      unitIds: [w.unitId],
    };
    ctx.queueOutbox(stockWriteInput(intent), now);
    levels.set(`${w.inventoryItemGid}|${w.locationId}`, [w.inventoryItemGid, w.locationId]);
  }

  // Lines of the order (display, metafield line order) and correspondence tables (12.1).
  const trackedLineGids = new Set<string>();
  for (const l of snapshot.lineItems) {
    if (l.variantGid && [...items.values()].some((i) => i.active && i.variantGid === l.variantGid)) trackedLineGids.add(l.gid);
  }
  for (const a of orderAllocations) trackedLineGids.add(a.lineItemGid);
  sql.exec('DELETE FROM order_lines WHERE order_gid = ?', orderGid);
  read.lines.forEach((l, position) => {
    sql.exec(
      'INSERT INTO order_lines (order_gid, line_item_gid, position, variant_gid, title, quantity, current_quantity, tracked) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      orderGid,
      l.gid,
      position,
      l.variantGid,
      l.title,
      l.quantity,
      l.currentQuantity,
      trackedLineGids.has(l.gid) ? 1 : 0,
    );
    const item = [...items.values()].find((i) => i.active && i.variantGid === l.variantGid);
    if (item) {
      sql.exec(
        "INSERT INTO order_line_tracking (order_gid, line_item_gid, tracked_item_id, mode) VALUES (?, ?, ?, 'tracked') ON CONFLICT DO NOTHING",
        orderGid,
        l.gid,
        item.id,
      );
    }
  });
  for (const fo of read.fulfillmentOrders) {
    sql.exec(
      'INSERT INTO fulfillment_orders (fo_gid, order_gid, location_id, status, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (fo_gid) DO UPDATE SET location_id = excluded.location_id, status = excluded.status, updated_at = excluded.updated_at',
      fo.gid,
      orderGid,
      fo.locationId,
      fo.status,
      now,
    );
  }
  for (const rl of read.returnLines) {
    sql.exec('INSERT INTO return_map (return_gid, order_gid) VALUES (?, ?) ON CONFLICT DO NOTHING', rl.returnGid, orderGid);
    sql.exec(
      'INSERT INTO return_lines (return_line_gid, return_gid, order_gid, line_item_gid, quantity) VALUES (?, ?, ?, ?, ?) ON CONFLICT (return_line_gid) DO UPDATE SET quantity = excluded.quantity',
      rl.gid,
      rl.returnGid,
      orderGid,
      rl.lineItemGid,
      rl.quantity,
    );
  }
  // Refunds restocked outside a return (EF-23) are identified on a synthetic return line (core D-06).
  for (const r of snapshot.refunds) {
    for (const l of r.lineItems) {
      if (l.restockType !== 'RETURN') continue;
      const gid = `${r.gid}#${l.lineItemGid}`;
      sql.exec(
        'INSERT INTO return_lines (return_line_gid, return_gid, order_gid, line_item_gid, quantity) VALUES (?, ?, ?, ?, ?) ON CONFLICT (return_line_gid) DO NOTHING',
        gid,
        r.gid,
        orderGid,
        l.lineItemGid,
        l.quantity,
      );
      sql.exec('INSERT INTO return_map (return_gid, order_gid) VALUES (?, ?) ON CONFLICT DO NOTHING', r.gid, orderGid);
    }
  }

  if (plan.metafield.write && !hasPendingMetafieldWrite(sql, orderGid)) ctx.queueOutbox(metafieldWriteInput(orderGid), now);

  // 11.2: the plan passes through intermediate states; the rule must hold at the end of the transaction.
  assertUnitsConsistent(ctx, [
    ...orderAllocations.map((a) => a.unitId),
    ...plan.unitTransitions.map((t) => t.unitId),
    ...plan.allocationsToCreate.map((a) => a.unitId),
    ...plan.allocationUpdates.map((u) => allocations.get(u.id)?.unitId).filter((id): id is string => typeof id === 'string'),
  ]);
  const inconsistency = repo.liveAnomaly('consistency_violation', { orderGid });
  if (inconsistency) repo.closeAnomaly(inconsistency.id, 'auto_resolved', { by: 'sync' }, now);

  sql.exec(
    `INSERT INTO order_sync (order_gid, status, has_tracked_lines, last_synced_at, shopify_updated_at, order_created_at, attempts, last_error)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL)
     ON CONFLICT (order_gid) DO UPDATE SET status = excluded.status, has_tracked_lines = excluded.has_tracked_lines,
       last_synced_at = excluded.last_synced_at, shopify_updated_at = excluded.shopify_updated_at, order_created_at = excluded.order_created_at,
       attempts = 0, last_error = NULL`,
    orderGid,
    plan.status,
    plan.status === 'ignored' && trackedLineGids.size === 0 ? 0 : 1,
    now,
    snapshot.updatedAt,
    snapshot.createdAt,
  );
  return { plan, levels: [...levels.values()] };
}

/** After a rolled-back plan: critical anomaly per order (11.2, R4 rule) and the order kept for R2. */
export function recordConsistencyViolation(ctx: DomainContext, orderGid: string, error: ConsistencyError, now: number): void {
  logEvent('error', 'sync_order.consistency_violation', { units: error.violations.length });
  ctx.storage.transactionSync(() => {
    ctx.repo.openAnomaly({
      type: 'consistency_violation',
      subject: { orderGid },
      details: {
        units: error.violations.map((v) => v.unitId).slice(0, 20),
        rule: error.violations.map((v) => `${v.status}:${v.detail}`).slice(0, 20),
        source: 'plan_application',
      },
      now,
    });
    ctx.sql.exec(
      `INSERT INTO order_sync (order_gid, status, attempts, last_error) VALUES (?, 'error', 1, 'consistency_violation')
       ON CONFLICT (order_gid) DO UPDATE SET status = 'error', attempts = order_sync.attempts + 1, last_error = 'consistency_violation'`,
      orderGid,
    );
  });
}

function applyExplained(ctx: DomainContext, orderGid: string, plan: SyncPlan, now: number): void {
  const { sql } = ctx;
  const key = (e: { sourceType: string; sourceRef: string; trackedItemId: string; locationId: string; inventoryState: string }) =>
    `${e.sourceType}|${e.sourceRef}|${e.trackedItemId}|${e.locationId}|${e.inventoryState}`;
  const existing = new Map(
    sql
      .exec<{ id: string; source_type: string; source_ref: string; tracked_item_id: string; location_id: string; inventory_state: string }>(
        "SELECT id, source_type, source_ref, tracked_item_id, location_id, inventory_state FROM explained_quantities WHERE order_gid = ? AND status = 'open'",
        orderGid,
      )
      .toArray()
      .map((r) => [key({ sourceType: r.source_type, sourceRef: r.source_ref, trackedItemId: r.tracked_item_id, locationId: r.location_id, inventoryState: r.inventory_state }), r.id]),
  );
  const desired = new Map(plan.explainedQuantities.map((e) => [key(e), e]));
  for (const [k, id] of existing) {
    if (!desired.has(k)) sql.exec("UPDATE explained_quantities SET status = 'closed', closed_at = ? WHERE id = ?", now, id);
  }
  for (const [k, e] of desired) {
    const id = existing.get(k);
    if (id) {
      sql.exec('UPDATE explained_quantities SET quantity = ?, direction = ? WHERE id = ?', e.quantity, e.direction, id);
    } else {
      sql.exec(
        `INSERT INTO explained_quantities (id, source_type, source_ref, order_gid, tracked_item_id, location_id, inventory_state, direction, quantity, status, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        newId(now),
        e.sourceType,
        e.sourceRef,
        orderGid,
        e.trackedItemId,
        e.locationId,
        e.inventoryState,
        e.direction,
        e.quantity,
        now,
      );
    }
  }
}
