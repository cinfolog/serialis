/** Plain-data model of the fake shop. Everything is JSON-serialisable so a test can `structuredClone` it. */

export const STORED_QUANTITY_NAMES = ['available', 'committed', 'reserved', 'damaged', 'quality_control', 'safety_stock', 'incoming'] as const;
export type StoredQuantityName = (typeof STORED_QUANTITY_NAMES)[number];
/** Names exposed through the API (`on_hand` is derived). */
export type QuantityName = StoredQuantityName | 'on_hand';
/** Names an app may write with `inventoryAdjustQuantities` / `inventoryMoveQuantities` (never `committed`). */
export const WRITABLE_QUANTITY_NAMES: readonly string[] = ['available', 'damaged', 'incoming', 'quality_control', 'reserved', 'safety_stock'];
/** Components of `on_hand` (spec section 8). */
export const ON_HAND_COMPONENTS: readonly StoredQuantityName[] = ['available', 'committed', 'reserved', 'damaged', 'safety_stock', 'quality_control'];

export interface Location {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
}

export interface Metafield {
  id: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  title: string;
  status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  variantIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Variant {
  id: string;
  productId: string;
  title: string;
  sku: string;
  inventoryItemId: string;
  metafields: Metafield[];
  createdAt: string;
  updatedAt: string;
}

export interface InventoryItem {
  id: string;
  variantId: string;
  sku: string;
  tracked: boolean;
}

export interface InventoryLevel {
  id: string;
  itemId: string;
  locationId: string;
  isActive: boolean;
  q: Record<StoredQuantityName, number>;
  updatedAt: string;
}

export interface LineItem {
  id: string;
  variantId: string | null;
  title: string;
  quantity: number;
  /** Quantity left after order edits and refunds. */
  currentQuantity: number;
  fulfilledQuantity: number;
  customAttributes: { key: string; value: string }[];
}

export type FulfillmentOrderStatus = 'OPEN' | 'IN_PROGRESS' | 'ON_HOLD' | 'SCHEDULED' | 'CLOSED' | 'CANCELLED';

export interface FulfillmentOrderLine {
  id: string;
  lineItemId: string;
  totalQuantity: number;
  remainingQuantity: number;
}

export interface FulfillmentHold {
  id: string;
  handle: string;
  reason: string;
  reasonNotes: string | null;
}

export interface FulfillmentOrder {
  id: string;
  orderId: string;
  status: FulfillmentOrderStatus;
  locationId: string;
  lines: FulfillmentOrderLine[];
  holds: FulfillmentHold[];
  fulfillAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Fulfillment {
  id: string;
  orderId: string;
  fulfillmentOrderId: string;
  locationId: string;
  status: 'SUCCESS' | 'CANCELLED';
  lines: { lineItemId: string; quantity: number }[];
  createdAt: string;
  updatedAt: string;
}

export type RestockType = 'RETURN' | 'CANCEL' | 'NO_RESTOCK' | 'LEGACY_RESTOCK';

export interface RefundLine {
  id: string;
  lineItemId: string;
  quantity: number;
  restockType: RestockType;
  locationId: string | null;
}

export interface Refund {
  id: string;
  orderId: string;
  createdAt: string;
  lines: RefundLine[];
}

export type DispositionType = 'RESTOCKED' | 'PROCESSING_REQUIRED' | 'NOT_RESTOCKED' | 'MISSING';

export interface ReverseLine {
  id: string;
  returnLineId: string;
  lineItemId: string;
  totalQuantity: number;
  dispositions: { type: DispositionType; quantity: number; locationId: string | null }[];
}

export interface ReverseFulfillmentOrder {
  id: string;
  returnId: string;
  status: 'OPEN' | 'CLOSED';
  lines: ReverseLine[];
}

export type ReturnStatus = 'REQUESTED' | 'OPEN' | 'CLOSED' | 'DECLINED' | 'CANCELED';

export interface Return {
  id: string;
  orderId: string;
  name: string;
  status: ReturnStatus;
  lines: { id: string; lineItemId: string; quantity: number; returnReason: string }[];
  reverseFulfillmentOrders: ReverseFulfillmentOrder[];
  createdAt: string;
}

export interface Order {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  closedAt: string | null;
  test: boolean;
  sourceName: 'web' | 'pos' | string;
  /** Selling location (POS register location). */
  retailLocationId: string | null;
  lines: LineItem[];
  metafields: Metafield[];
}

export interface BulkOperation {
  id: string;
  status: 'CREATED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED';
  type: 'QUERY';
  query: string;
  createdAt: string;
  completedAt: string | null;
  url: string | null;
  objectCount: number;
}

export interface WebhookEvent {
  /** Value of X-Shopify-Webhook-Id. */
  id: string;
  topic: string;
  shopDomain: string;
  apiVersion: string;
  triggeredAt: string;
  payload: unknown;
}
