import type { Gid, LocationId, Millis } from './types.js';

/**
 * What `sync_order` reads from Shopify (spec 12.3 step 1), Shopify-shaped but independent of
 * any HTTP client. No customer data (P8). The caller maps location GIDs to `LocationId`.
 */

export type OrderChannel = 'online_store' | 'pos' | 'draft_order' | 'marketplace' | 'other';

export interface LineItemSnapshot {
  readonly gid: Gid;
  /** Null when the variant was deleted. */
  readonly variantGid: Gid | null;
  /** Quantity at creation. */
  readonly quantity: number;
  /** Quantity after edits and refunds. */
  readonly currentQuantity: number;
  /** Raw value of the `_serialis_units` line property (POS tokens, F8), if any. */
  readonly serialisUnitsProperty: string | null;
}

export type FulfillmentOrderStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'ON_HOLD'
  | 'SCHEDULED'
  | 'INCOMPLETE'
  | 'CLOSED'
  | 'CANCELLED';

export interface FulfillmentOrderLineSnapshot {
  readonly gid: Gid;
  readonly lineItemGid: Gid;
  readonly totalQuantity: number;
  readonly remainingQuantity: number;
}

export interface FulfillmentOrderSnapshot {
  readonly gid: Gid;
  readonly status: FulfillmentOrderStatus;
  readonly locationId: LocationId;
  readonly lineItems: readonly FulfillmentOrderLineSnapshot[];
}

export type FulfillmentStatus = 'SUCCESS' | 'OPEN' | 'PENDING' | 'CANCELLED' | 'ERROR' | 'FAILURE';

export interface FulfillmentSnapshot {
  readonly gid: Gid;
  readonly status: FulfillmentStatus;
  readonly locationId: LocationId;
  readonly createdAt: Millis;
  readonly lineItems: readonly { readonly lineItemGid: Gid; readonly quantity: number }[];
}

export type RestockType = 'CANCEL' | 'NO_RESTOCK' | 'RETURN' | 'LEGACY_RESTOCK';

export interface RefundSnapshot {
  readonly gid: Gid;
  readonly createdAt: Millis;
  readonly lineItems: readonly {
    readonly lineItemGid: Gid;
    readonly quantity: number;
    readonly restockType: RestockType;
    readonly locationId: LocationId | null;
  }[];
}

/** Removal of a quantity by an order edit; `restock` is null when unknown (F3, PV-14). */
export interface OrderEditRemoval {
  readonly lineItemGid: Gid;
  readonly quantity: number;
  readonly restock: boolean | null;
}

export type ReturnStatus = 'REQUESTED' | 'OPEN' | 'CLOSED' | 'DECLINED' | 'CANCELED';
export type DispositionType = 'RESTOCKED' | 'PROCESSING_REQUIRED' | 'NOT_RESTOCKED' | 'MISSING';

export interface ReturnSnapshot {
  readonly gid: Gid;
  readonly status: ReturnStatus;
  readonly lineItems: readonly {
    readonly gid: Gid;
    readonly lineItemGid: Gid;
    readonly quantity: number;
    /**
     * `ReturnLineItem.processedQuantity` (return processing, API 2025-07+): quantity received and decided by
     * `returnProcess`. A processed quantity without a disposition was not restocked (workers/DECISIONS.md 79).
     */
    readonly processedQuantity?: number;
  }[];
  /**
   * Reverse fulfillment order dispositions, in the order Shopify reports them. `locationId` is null when Shopify
   * gives no location: always for `NOT_RESTOCKED` and `MISSING` (nothing is restocked anywhere).
   */
  readonly dispositions: readonly {
    readonly returnLineItemGid: Gid;
    readonly type: DispositionType;
    readonly quantity: number;
    readonly locationId: LocationId | null;
  }[];
}

export interface OrderSnapshot {
  readonly orderGid: Gid;
  readonly name: string;
  readonly createdAt: Millis;
  readonly updatedAt: Millis;
  readonly cancelledAt: Millis | null;
  readonly test: boolean;
  readonly channel: OrderChannel;
  readonly retailLocationId: LocationId | null;
  /** Raw JSON of the `serialis.units` metafield as read, or null. */
  readonly metafieldValue: string | null;
  readonly lineItems: readonly LineItemSnapshot[];
  readonly fulfillmentOrders: readonly FulfillmentOrderSnapshot[];
  readonly fulfillments: readonly FulfillmentSnapshot[];
  readonly refunds: readonly RefundSnapshot[];
  readonly edits: readonly OrderEditRemoval[];
  readonly returns: readonly ReturnSnapshot[];
}

/** Fulfillment order statuses whose remaining quantity must be covered by ALLOCATED units (12.3 step 3). */
export const ALLOCATABLE_FO_STATUSES: ReadonlySet<FulfillmentOrderStatus> = new Set(['OPEN', 'IN_PROGRESS', 'ON_HOLD']);

/** Fulfillment statuses that count as shipped (DECISIONS.md, D-08). */
export const SHIPPED_FULFILLMENT_STATUSES: ReadonlySet<FulfillmentStatus> = new Set(['SUCCESS', 'OPEN', 'PENDING']);
