import type { UnitState } from '../states.js';
import type { AnomalyType } from '../anomalies.js';
import type {
  Allocation,
  AnomalyDetails,
  AnomalySubject,
  ExplainedQuantity,
  Gid,
  LocationId,
  Severity,
  StockWriteIntent,
  TrackedItem,
  Unit,
  UnitLock,
  Anomaly,
} from '../types.js';

/** What the store gives `planOrderSync` (read inside the transaction of 12.3 step 4). */
export interface SyncState {
  readonly trackedItems: readonly TrackedItem[];
  /** Units of the tracked items that appear in the order (allocation candidates included). */
  readonly units: readonly Unit[];
  /** Every allocation of the order, plus the `active`/`fulfilled` allocations of the units above. */
  readonly allocations: readonly Allocation[];
  /** Anomalies whose subject is the order (any status; others are ignored). */
  readonly anomalies: readonly Anomaly[];
  readonly locks: readonly UnitLock[];
  /** `order_line_tracking` lines marked `preexisting` (EF-01, S-24). */
  readonly preexistingLineItemGids: readonly Gid[];
  /** Refs typed at return reception, already matched by `designateUnit` (15.5); null = unknown ref. */
  readonly returnIdentifications: readonly ReturnIdentification[];
  /** Emergency stop of the shop (EF-33): no automatic allocation. */
  readonly automationPaused: boolean;
}

export interface ReturnIdentification {
  readonly returnLineItemGid: Gid;
  readonly unitId: string | null;
  readonly typedRef: string;
}

export type UnitEventType =
  | 'allocated'
  | 'released'
  | 'to_verify'
  | 'shipped'
  | 'shipment_cancelled'
  | 'return_pending'
  | 'return_cancelled'
  | 'returned';

export interface UnitTransition {
  readonly unitId: string;
  readonly from: UnitState;
  readonly to: UnitState;
  /** Location of the unit after the transition. */
  readonly locationId: LocationId | null;
  readonly allocationId: string | null;
  readonly event: UnitEventType;
  /** The pair is guarded in `transitions.ts`; the engine checked the business guard. */
  readonly guarded: boolean;
  readonly data: AnomalyDetails;
}

export interface RejectedTransition {
  readonly unitId: string;
  readonly from: UnitState | null;
  readonly to: UnitState;
  readonly reason: 'forbidden_transition' | 'unexpected_state';
}

export interface AllocationUpdate {
  readonly id: string;
  readonly patch: Partial<Omit<Allocation, 'id' | 'unitId' | 'orderGid' | 'lineItemGid'>>;
}

export interface AnomalyDraft {
  readonly id: string;
  readonly type: AnomalyType;
  readonly severity: Severity;
  readonly subject: AnomalySubject;
  readonly fingerprint: string;
  readonly details: AnomalyDetails;
}

/** `uncovered_lines` row: unfulfilled quantity of a tracked FO line without a unit. */
export interface UncoveredLine {
  readonly foLineItemGid: Gid;
  readonly foGid: Gid;
  readonly orderGid: Gid;
  readonly lineItemGid: Gid;
  readonly trackedItemId: string;
  readonly locationId: LocationId;
  readonly quantity: number;
}

export type ExplainedQuantityDraft = Omit<ExplainedQuantity, 'status'>;

export interface SyncPlan {
  readonly orderGid: Gid;
  /** `order_sync.status`. */
  readonly status: 'ignored' | 'ok' | 'short';
  readonly allocationsToCreate: readonly Allocation[];
  readonly allocationUpdates: readonly AllocationUpdate[];
  /** In application order; a unit may have several (e.g. SHIPPED → RETURN_PENDING → AVAILABLE). */
  readonly unitTransitions: readonly UnitTransition[];
  readonly anomaliesToOpen: readonly AnomalyDraft[];
  readonly anomaliesToUpdate: readonly { readonly id: string; readonly details: AnomalyDetails }[];
  readonly anomaliesToResolve: readonly string[];
  /** Stock writes owned by the app (7.2 "App"); every other move is written by Shopify. */
  readonly stockWrites: readonly StockWriteIntent[];
  /** Full desired set of `uncovered_lines` for the order (replaces the stored rows). */
  readonly uncoveredLines: readonly UncoveredLine[];
  /** Full desired set of open explained quantities whose source is this order. */
  readonly explainedQuantities: readonly ExplainedQuantityDraft[];
  /** New `serialis.units` value; `write` is false when it equals the value read. */
  readonly metafield: { readonly value: string | null; readonly write: boolean };
  /** Transitions refused by `checkTransition` or by an unexpected unit state; never applied. */
  readonly rejected: readonly RejectedTransition[];
}

/** No write at all: what a replayed sync must produce (T-IDEM-01). Desired sets are not writes. */
export function isEmptyPlan(plan: SyncPlan): boolean {
  return (
    plan.allocationsToCreate.length === 0 &&
    plan.allocationUpdates.length === 0 &&
    plan.unitTransitions.length === 0 &&
    plan.anomaliesToOpen.length === 0 &&
    plan.anomaliesToUpdate.length === 0 &&
    plan.anomaliesToResolve.length === 0 &&
    plan.stockWrites.length === 0 &&
    !plan.metafield.write
  );
}
