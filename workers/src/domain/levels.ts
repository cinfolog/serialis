/**
 * Task `sync_inventory_level` (spec 12.2, 12.5): re-reads one level of a tracked item and checks
 * I1, I3 and I5 (section 8). A gap that lasts longer than the grace period S-22 opens an anomaly;
 * nothing is corrected automatically in the MVP (strict mode S-21 is lot 2, T-MVP-09). During the
 * initialization phase gaps are "units to register" without anomaly, and the phase ends once I1
 * holds (S-25 = auto, EF-01).
 */
import { checkInvariants, initializationShouldEnd, resolveSetting, type AnomalyType, type InvariantViolation } from '@serialis/core';
import type { TaskContext, TaskResult } from '../tasks.js';
import type { DomainContext } from './context.js';
import type { TrackedItemRow } from './repo.js';
import { readLevel, type LevelRead } from './shopify-read.js';

const LEVEL_ANOMALIES: readonly AnomalyType[] = ['stock_mismatch_missing_units', 'stock_mismatch_extra_units', 'inventory_invariant_violation'];
/** While the app's own writes of this level are in flight, the check waits (8.1 "écriture de l'app non aboutie"). */
const IN_FLIGHT_RECHECK_MS = 30_000;

export async function runInventoryLevelCheck(
  ctx: DomainContext,
  payload: { inventoryItemId?: unknown; locationId?: unknown },
  task: Pick<TaskContext, 'holdsLease'>,
): Promise<TaskResult> {
  const itemGid = `gid://shopify/InventoryItem/${String(payload.inventoryItemId)}`;
  const locationId = `gid://shopify/Location/${String(payload.locationId)}`;
  const item = ctx.repo.itemByInventoryItem(itemGid);
  if (!item || !item.active) return; // not tracked: nothing read (12.1)
  const level = await readLevel(ctx.client(), itemGid, locationId);
  if (!level) return;
  const now = Date.now();
  return ctx.storage.transactionSync(() => {
    if (!task.holdsLease()) return;
    storeLevel(ctx, item, locationId, level, now);
    const next = evaluateLevel(ctx, item, locationId, now);
    return next === null ? undefined : { rescheduleAt: next };
  });
}

export function storeLevel(ctx: DomainContext, item: TrackedItemRow, locationId: string, level: LevelRead, now: number): void {
  ctx.repo.ensureLocation(locationId, now);
  ctx.repo.saveLevel(
    item.id,
    locationId,
    {
      active: level.active,
      onHand: level.q.on_hand,
      available: level.q.available,
      committed: level.q.committed,
      reserved: level.q.reserved,
      qualityControl: level.q.quality_control,
      damaged: level.q.damaged,
      safetyStock: level.q.safety_stock,
    },
    now,
  );
  if (!level.tracked) {
    ctx.repo.openAnomaly({ type: 'tracking_disabled_in_shopify', subject: { trackedItemId: item.id, variantGid: item.variantGid }, details: {}, now });
  }
}

function anomalyFor(v: InvariantViolation): AnomalyType {
  if (v.invariant === 'I3') return 'inventory_invariant_violation';
  if (v.invariant === 'I1') return v.detail === 'missing_units' ? 'stock_mismatch_missing_units' : 'stock_mismatch_extra_units';
  return v.actual > v.expected ? 'stock_mismatch_missing_units' : 'stock_mismatch_extra_units';
}

/** I1, I3 and I5 on the stored level of one location. */
function levelViolations(ctx: DomainContext, item: TrackedItemRow, locationId: string): InvariantViolation[] {
  const { repo } = ctx;
  const level = repo.cachedLevel(item.id, locationId);
  if (!level) return [];
  const units = repo.unitsAt(item.id, locationId);
  const explained = repo.explainedFor(item.id, locationId);
  // 8.1: a gap covered by units to verify is explained (Shopify may have restocked them), up to their number.
  const toVerify = units.filter((u) => u.status === 'TO_VERIFY').length;
  if (toVerify > 0) {
    explained.push({ sourceType: 'to_verify_restocked', sourceRef: `to_verify|${item.id}|${locationId}`, trackedItemId: item.id, locationId, inventoryState: 'available', direction: 'deficit', quantity: toVerify, status: 'open' });
  }
  return checkInvariants({ levels: [level], units, uncovered: repo.uncoveredFor(item.id, locationId), explained }).filter(
    (v) => v.invariant === 'I1' || v.invariant === 'I3' || v.invariant === 'I5',
  );
}

/**
 * Checks the stored level against the units (synchronous, inside a transaction). Returns when the
 * check must run again (grace period, writes in flight), or null.
 */
export function evaluateLevel(ctx: DomainContext, item: TrackedItemRow, locationId: string, now: number): number | null {
  const { repo } = ctx;
  const level = repo.cachedLevel(item.id, locationId);
  if (!level) return null;
  if (repo.pendingStockWrites(item.inventoryItemGid, locationId) > 0) return now + IN_FLIGHT_RECHECK_MS;

  const violations = levelViolations(ctx, item, locationId);
  const live = repo.liveAnomaliesOfLevel(item.id, locationId, LEVEL_ANOMALIES);
  const closeAll = (keep: Set<string>) => {
    for (const a of live) if (!keep.has(a.fingerprint)) repo.closeAnomaly(a.id, 'auto_resolved', { by: 'level_check' }, now);
  };

  if (item.initializing) {
    // EF-01: gaps are shown as units to register, without anomaly.
    const settings = repo.storedSettings();
    // The phase belongs to the item: it ends when I1 holds at every location it is stocked at.
    const i1 = repo.levelsOfItem(item.id).every((l) => !levelViolations(ctx, item, l.locationId).some((v) => v.invariant === 'I1'));
    if (initializationShouldEnd(resolveSetting('S-25', { trackedItemId: item.id }, settings), i1, false)) repo.setItemInitializing(item.id, false, now);
    repo.setGapSince(item.id, locationId, null);
    closeAll(new Set());
    return null;
  }
  if (violations.length === 0) {
    repo.setGapSince(item.id, locationId, null);
    closeAll(new Set());
    return null;
  }
  const grace = resolveSetting('S-22', { trackedItemId: item.id, locationId }, repo.storedSettings());
  const since = level.gapSince ?? now;
  if (level.gapSince === null) repo.setGapSince(item.id, locationId, since);
  if (now - since < grace) return since + grace;

  const keep = new Set<string>();
  for (const v of violations) {
    const type = anomalyFor(v);
    const subject = { trackedItemId: item.id, locationId, variantGid: item.variantGid };
    const id = repo.openAnomaly({
      type,
      subject,
      details: { invariant: v.invariant, detail: v.detail, shopify: v.actual, units: v.expected, explained: v.explained, gap: v.actual - v.expected },
      now,
    });
    const opened = repo.anomaly(id);
    if (opened) keep.add(opened.fingerprint);
  }
  closeAll(keep);
  return null;
}
