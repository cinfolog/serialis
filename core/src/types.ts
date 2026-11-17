import type { ShopifyQuantityName, UnitState } from './states.js';
import type { AnomalyType } from './anomalies.js';

/**
 * Domain types of the pure engine — spec sections 4 and 11.2.
 *
 * Locations: the engine uses one opaque `LocationId` everywhere (units, allocations,
 * snapshot, stock intents). The caller maps Shopify location GIDs to it (core/DECISIONS.md, D-01).
 */

export type Gid = string;
export type LocationId = string;
/** Milliseconds since the epoch, UTC (spec 11 conventions). */
export type Millis = number;

export interface UnitIdentifier {
  readonly type: string;
  readonly value: string;
  readonly primary: boolean;
  /** Old value kept after a correction (EF-08); never used to designate a unit. */
  readonly retired?: boolean;
}

/** `tracked_items` row (EF-01). Only `pooled` items are synchronized in the MVP. */
export interface TrackedItem {
  readonly id: string;
  readonly productGid: Gid;
  readonly variantGid: Gid;
  readonly inventoryItemGid: Gid;
  readonly mode: 'pooled' | 'unique';
  readonly activatedAt: Millis;
  readonly initializing: boolean;
  readonly active: boolean;
}

/** `units` row, reduced to what the engine reads. */
export interface Unit {
  readonly id: string;
  readonly trackedItemId: string;
  readonly status: UnitState;
  readonly locationId: LocationId | null;
  readonly identifiers: readonly UnitIdentifier[];
  readonly receivedAt: Millis | null;
  readonly expiresAt: Millis | null;
  readonly warrantyEndsAt: Millis | null;
  /** 1 when the app moved the quantity to `reserved` (HELD units). */
  readonly holdMovedStock: boolean;
  /** Designated in a native transfer shipment (`native_shipment_gid` set): excluded from allocation (F12). */
  readonly packedForShipment: boolean;
  readonly version: number;
}

export type AllocationStatus = 'active' | 'fulfilled' | 'released' | 'returned';
export type AllocationSource = 'auto' | 'pick' | 'pos' | 'draft' | 'api' | 'late' | 'migration';

/**
 * Why an allocation was released. Not a column of 11.2 yet (DECISIONS.md, D-05): it lets a
 * replayed sync know how much of a line's restock information was already consumed.
 */
export type ReleaseKind = 'restocked' | 'not_restocked' | 'relocated' | 'ignored_order' | 'manual';

/** `allocations` row: one row per unit (11.2). */
export interface Allocation {
  readonly id: string;
  readonly unitId: string;
  readonly variantGid: Gid;
  readonly orderGid: Gid;
  readonly lineItemGid: Gid;
  readonly fulfillmentOrderGid: Gid | null;
  readonly fulfillmentOrderLineItemGid: Gid | null;
  readonly locationId: LocationId;
  readonly status: AllocationStatus;
  readonly source: AllocationSource;
  readonly returnExpected: boolean;
  /** Shipment provisionally designated (F4, `shipped_unit_to_confirm`). */
  readonly toConfirm: boolean;
  readonly allocationVersion: number;
  readonly allocatedAt: Millis;
  readonly fulfilledAt: Millis | null;
  readonly releasedAt: Millis | null;
  readonly returnedAt: Millis | null;
  readonly releaseKind: ReleaseKind | null;
  /** Return line (or synthetic refund line) the unit is expected back on (`expected_returns`, D-06). */
  readonly returnLineItemGid: Gid | null;
}

/** `unit_locks` row (POS, pick, API). */
export interface UnitLock {
  readonly unitId: string;
  readonly kind: 'pos' | 'pick' | 'api';
  readonly owner: string;
  readonly expiresAt: Millis;
}

export type Severity = 'critical' | 'warning' | 'info';
export type AnomalyStatus = 'open' | 'acknowledged' | 'resolved' | 'auto_resolved';

export interface AnomalySubject {
  readonly orderGid?: Gid;
  readonly lineItemGid?: Gid;
  readonly returnLineItemGid?: Gid;
  readonly unitId?: string;
  readonly variantGid?: Gid;
  readonly trackedItemId?: string;
  readonly locationId?: LocationId;
}

export type AnomalyDetails = Readonly<Record<string, string | number | boolean | readonly string[] | null>>;

/** `anomalies` row (11.2, catalogue 12.7). */
export interface Anomaly {
  readonly id: string;
  readonly type: AnomalyType;
  readonly severity: Severity;
  readonly subject: AnomalySubject;
  /** Canonical key; the store hashes it with SHA-256 (D-07). */
  readonly fingerprint: string;
  readonly details: AnomalyDetails;
  readonly status: AnomalyStatus;
  readonly detectedAt: Millis;
  readonly resolvedAt: Millis | null;
}

/**
 * Stock write intent for the outbox (7.2, 12.4). `changeFrom` is read by the outbox just
 * before the first send; the engine never sets it from stale data.
 */
export interface StockWriteIntent {
  readonly kind: 'adjust' | 'move';
  readonly inventoryItemGid: Gid;
  readonly locationId: LocationId;
  /** Adjusted quantity (adjust), or destination quantity (move). */
  readonly quantityName: ShopifyQuantityName;
  /** Source quantity of a move. */
  readonly fromQuantityName?: ShopifyQuantityName;
  readonly delta: number;
  readonly changeFrom?: number;
  readonly unitId: string;
  readonly reason: string;
}

export type ExplainedSourceType =
  | 'return_unidentified'
  | 'to_verify_restocked'
  | 'native_receipt_undesignated'
  | 'native_shipment_undesignated'
  | 'pre_activation_return'
  | 'sale_without_unit'
  | 'preexisting_sale'
  | 'test_order_shipment';

/** `explained_quantities` row (section 8). */
export interface ExplainedQuantity {
  readonly sourceType: ExplainedSourceType;
  readonly sourceRef: string;
  readonly trackedItemId: string;
  readonly locationId: LocationId;
  readonly inventoryState: 'available' | 'quality_control' | 'damaged';
  /** `deficit`: Shopify counts more than the units; `surplus`: the units exceed Shopify. */
  readonly direction: 'surplus' | 'deficit';
  readonly quantity: number;
  readonly status: 'open' | 'closed';
}

/** Shopify quantities of one (tracked item, location) inventory level. */
export interface InventoryLevel {
  readonly trackedItemId: string;
  readonly locationId: LocationId;
  readonly onHand: number;
  readonly available: number;
  readonly committed: number;
  readonly reserved: number;
  readonly qualityControl: number;
  readonly damaged: number;
}
