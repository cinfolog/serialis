import { countedUnits } from './stock.js';
import type { ExplainedQuantity, InventoryLevel, LocationId, Unit } from './types.js';

/** Stock invariants I1 to I6 — spec section 8. Checks return violations; they never throw. */

export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6';

export interface InvariantViolation {
  readonly invariant: InvariantId;
  readonly trackedItemId: string;
  readonly locationId: LocationId | null;
  readonly unitId?: string;
  /** Shopify side. */
  readonly actual: number;
  /** What the units require (bound for inequalities). */
  readonly expected: number;
  /** Part of the gap explained by a known cause (`explained_quantities`, 8.1). */
  readonly explained: number;
  readonly detail: string;
}

/** Level of the variant of a unique-mode unit (I6). */
export interface UniqueVariantLevel {
  readonly unitId: string;
  readonly onHand: number;
  readonly available: number;
  readonly committedAnywhere: boolean;
}

export interface InvariantInput {
  readonly levels: readonly InventoryLevel[];
  readonly units: readonly Unit[];
  /** Waiting quantity per (item, location): sum of `uncovered_lines` (8). */
  readonly uncovered: readonly { readonly trackedItemId: string; readonly locationId: LocationId; readonly quantity: number }[];
  readonly explained: readonly ExplainedQuantity[];
  readonly uniqueLevels?: readonly UniqueVariantLevel[];
}

function sumExplained(
  explained: readonly ExplainedQuantity[],
  level: InventoryLevel,
  direction: ExplainedQuantity['direction'],
  state?: ExplainedQuantity['inventoryState'],
): number {
  return explained
    .filter(
      (e) =>
        e.status === 'open' &&
        e.direction === direction &&
        e.trackedItemId === level.trackedItemId &&
        e.locationId === level.locationId &&
        (state === undefined || e.inventoryState === state),
    )
    .reduce((s, e) => s + e.quantity, 0);
}

export function checkInvariants(input: InvariantInput): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (const level of input.levels) violations.push(...checkLevel(level, input));
  for (const ul of input.uniqueLevels ?? []) {
    const v = checkUnique(ul, input.units);
    if (v) violations.push(v);
  }
  return violations;
}

function checkLevel(level: InventoryLevel, input: InvariantInput): InvariantViolation[] {
  const { trackedItemId, locationId } = level;
  const here = input.units.filter((u) => u.trackedItemId === trackedItemId && u.locationId === locationId);
  const count = (pred: (u: Unit) => boolean) => here.filter(pred).length;
  const pending = input.uncovered
    .filter((u) => u.trackedItemId === trackedItemId && u.locationId === locationId)
    .reduce((s, u) => s + u.quantity, 0);
  const base = { trackedItemId, locationId };
  const out: InvariantViolation[] = [];

  // I1 — on_hand = counted units, net of explained gaps in the direction of the gap.
  const counted = countedUnits(input.units, trackedItemId, locationId);
  const gap = level.onHand - counted;
  if (gap !== 0) {
    const explained = sumExplained(input.explained, level, gap > 0 ? 'deficit' : 'surplus');
    if (Math.abs(gap) > explained) {
      out.push({ ...base, invariant: 'I1', actual: level.onHand, expected: counted, explained, detail: gap > 0 ? 'missing_units' : 'extra_units' });
    }
  }

  // I2 — committed ≥ ALLOCATED + waiting.
  const allocated = count((u) => u.status === 'ALLOCATED');
  if (level.committed < allocated + pending) {
    out.push({ ...base, invariant: 'I2', actual: level.committed, expected: allocated + pending, explained: 0, detail: 'committed_below_allocated' });
  }

  // I3 — available ≤ AVAILABLE not packed − waiting + E.
  const sellable = count((u) => u.status === 'AVAILABLE' && !u.packedForShipment);
  const e = sumExplained(input.explained, level, 'deficit', 'available');
  if (level.available > sellable - pending + e) {
    out.push({ ...base, invariant: 'I3', actual: level.available, expected: sellable - pending + e, explained: e, detail: 'oversell_risk' });
  }

  // I4 — reserved ≥ HELD units whose quantity the app moved.
  const held = count((u) => u.status === 'HELD' && u.holdMovedStock);
  if (level.reserved < held) {
    out.push({ ...base, invariant: 'I4', actual: level.reserved, expected: held, explained: 0, detail: 'reserved_below_held' });
  }

  // I5 — quality_control and damaged equal the units in those states.
  const qc = count((u) => u.status === 'QUALITY_CONTROL');
  if (level.qualityControl !== qc) {
    out.push({ ...base, invariant: 'I5', actual: level.qualityControl, expected: qc, explained: 0, detail: 'quality_control' });
  }
  const damaged = count((u) => u.status === 'DAMAGED');
  if (level.damaged !== damaged) {
    out.push({ ...base, invariant: 'I5', actual: level.damaged, expected: damaged, explained: 0, detail: 'damaged' });
  }
  return out;
}

/** I6 — unique mode: on_hand = 1 iff counted; available = 1 only if AVAILABLE and committed nowhere. */
function checkUnique(ul: UniqueVariantLevel, units: readonly Unit[]): InvariantViolation | null {
  const unit = units.find((u) => u.id === ul.unitId);
  if (!unit) return null;
  const base = { invariant: 'I6' as const, trackedItemId: unit.trackedItemId, locationId: unit.locationId, unitId: unit.id, explained: 0 };
  const counted = unit.locationId !== null && ['AVAILABLE', 'HELD', 'ALLOCATED', 'QUALITY_CONTROL', 'DAMAGED'].includes(unit.status);
  const expectedOnHand = counted ? 1 : 0;
  if (ul.onHand !== expectedOnHand) return { ...base, actual: ul.onHand, expected: expectedOnHand, detail: 'on_hand' };
  const maxAvailable = unit.status === 'AVAILABLE' && !ul.committedAnywhere ? 1 : 0;
  if (ul.available > maxAvailable) return { ...base, actual: ul.available, expected: maxAvailable, detail: 'available' };
  return null;
}

// ------------------------------------------------------------------------------------------------
// Allocation ↔ unit consistency (11.2)

/** Minimal views of the rows checked by `checkAllocationConsistency` (the store passes raw rows). */
export interface ConsistencyUnit {
  readonly id: string;
  readonly status: Unit['status'];
}

export interface ConsistencyAllocation {
  readonly id: string;
  readonly unitId: string;
  readonly status: 'active' | 'fulfilled' | 'released' | 'returned';
}

export interface ConsistencyViolation {
  readonly unitId: string;
  readonly status: Unit['status'];
  readonly active: number;
  readonly fulfilled: number;
  readonly detail: 'allocated_without_one_active' | 'shipped_with_active' | 'shipped_with_several_fulfilled' | 'engaged_in_other_state';
}

/**
 * Rule of 11.2: an ALLOCATED unit has exactly one `active` allocation; a SHIPPED or RETURN_PENDING
 * unit has no `active` allocation and at most one `fulfilled` (none for a historical sale); any other
 * unit has neither. SQLite has no deferred trigger and the sync plan passes through legitimate
 * intermediate states, so the store runs this check at the end of the transaction that applies a plan
 * (workers/DECISIONS.md) and the daily audit R4 runs it over the whole base. Never throws.
 */
export function checkAllocationConsistency(
  units: readonly ConsistencyUnit[],
  allocations: readonly ConsistencyAllocation[],
): ConsistencyViolation[] {
  const counts = new Map<string, { active: number; fulfilled: number }>();
  for (const a of allocations) {
    if (a.status !== 'active' && a.status !== 'fulfilled') continue;
    const c = counts.get(a.unitId) ?? { active: 0, fulfilled: 0 };
    if (a.status === 'active') c.active += 1;
    else c.fulfilled += 1;
    counts.set(a.unitId, c);
  }
  const out: ConsistencyViolation[] = [];
  for (const u of units) {
    const { active, fulfilled } = counts.get(u.id) ?? { active: 0, fulfilled: 0 };
    const base = { unitId: u.id, status: u.status, active, fulfilled };
    if (u.status === 'ALLOCATED') {
      if (active !== 1 || fulfilled !== 0) out.push({ ...base, detail: 'allocated_without_one_active' });
    } else if (u.status === 'SHIPPED' || u.status === 'RETURN_PENDING') {
      if (active > 0) out.push({ ...base, detail: 'shipped_with_active' });
      else if (fulfilled > 1) out.push({ ...base, detail: 'shipped_with_several_fulfilled' });
    } else if (active > 0 || fulfilled > 0) {
      out.push({ ...base, detail: 'engaged_in_other_state' });
    }
  }
  return out;
}
