import type {
  BulkOperation,
  FulfillmentOrder,
  Fulfillment,
  InventoryItem,
  InventoryLevel,
  Location,
  Order,
  Product,
  QuantityName,
  Refund,
  Return,
  StoredQuantityName,
  Variant,
  WebhookEvent,
} from './model.js';
import { ON_HAND_COMPONENTS } from './model.js';
import { Clock, gid, numericId } from './util.js';

export interface ShopOptions {
  domain?: string;
  apiVersion?: string;
  clock?: Clock;
  /** Granted installation scopes (handles). */
  scopes?: string[];
}

export const DEFAULT_SCOPES = [
  'read_products',
  'write_products',
  'read_inventory',
  'write_inventory',
  'read_locations',
  'read_orders',
  'write_orders',
  'read_all_orders',
  'read_fulfillments',
  'read_merchant_managed_fulfillment_orders',
  'write_merchant_managed_fulfillment_orders',
  'read_third_party_fulfillment_orders',
  'read_returns',
];

export interface SeedVariant {
  title?: string;
  sku?: string;
  /** Default true. */
  tracked?: boolean;
  /** Initial `available` by location id (levels are created and active). */
  stock?: Record<string, number>;
}

function zeroQuantities(): Record<StoredQuantityName, number> {
  return { available: 0, committed: 0, reserved: 0, damaged: 0, quality_control: 0, safety_stock: 0, incoming: 0 };
}

/** The raw state of the fake shop plus the primitives every layer (scenarios and GraphQL) shares. */
export class Shop {
  readonly domain: string;
  readonly apiVersion: string;
  readonly clock: Clock;
  scopes: string[];
  installedAt: string;

  readonly locations = new Map<string, Location>();
  readonly products = new Map<string, Product>();
  readonly variants = new Map<string, Variant>();
  readonly items = new Map<string, InventoryItem>();
  readonly levels = new Map<string, InventoryLevel>();
  readonly orders = new Map<string, Order>();
  readonly fulfillmentOrders = new Map<string, FulfillmentOrder>();
  readonly fulfillments = new Map<string, Fulfillment>();
  readonly refunds = new Map<string, Refund>();
  readonly returns = new Map<string, Return>();
  readonly bulkOperations = new Map<string, BulkOperation>();

  /** Webhooks emitted so far, in emission order. Delivery is up to the test (see `WebhookDelivery`). */
  readonly events: WebhookEvent[] = [];

  private counters: Record<string, number> = {};
  private webhookSeq = 0;
  private batchDepth = 0;
  private batchBefore = new Map<string, number>();

  constructor(opts: ShopOptions = {}) {
    this.domain = opts.domain ?? 'sim-shop.myshopify.com';
    this.apiVersion = opts.apiVersion ?? '2026-10';
    this.clock = opts.clock ?? new Clock();
    this.scopes = [...(opts.scopes ?? DEFAULT_SCOPES)];
    this.installedAt = this.clock.iso();
  }

  nextId(type: string): string {
    const n = (this.counters[type] ?? 1000) + 1;
    this.counters[type] = n;
    return gid(type, n);
  }

  /** Next human order number (1001, 1002, ...). */
  nextOrderNumber(): number {
    const n = (this.counters['__orderNumber'] ?? 1000) + 1;
    this.counters['__orderNumber'] = n;
    return n;
  }

  /** Returns the current ISO time and moves the clock by 1 ms. */
  stamp(): string {
    this.clock.tick();
    return this.clock.iso();
  }

  emit(topic: string, payload: unknown): WebhookEvent {
    this.webhookSeq += 1;
    const event: WebhookEvent = {
      id: `sim-wh-${String(this.webhookSeq).padStart(6, '0')}`,
      topic,
      shopDomain: this.domain,
      apiVersion: this.apiVersion,
      triggeredAt: this.stamp(),
      payload,
    };
    this.events.push(event);
    return event;
  }

  // ---- seeding (no webhooks) -------------------------------------------------------------

  addLocation(name: string, opts: { active?: boolean } = {}): Location {
    const loc: Location = { id: this.nextId('Location'), name, isActive: opts.active ?? true, createdAt: this.stamp() };
    this.locations.set(loc.id, loc);
    return loc;
  }

  addProduct(title: string, variants: SeedVariant[] = [{}]): { product: Product; variants: Variant[]; items: InventoryItem[] } {
    const now = this.stamp();
    const product: Product = { id: this.nextId('Product'), title, status: 'ACTIVE', variantIds: [], createdAt: now, updatedAt: now };
    this.products.set(product.id, product);
    const outV: Variant[] = [];
    const outI: InventoryItem[] = [];
    variants.forEach((sv, i) => {
      const variantId = this.nextId('ProductVariant');
      const itemId = this.nextId('InventoryItem');
      const sku = sv.sku ?? `SKU-${numericId(variantId)}`;
      const variant: Variant = {
        id: variantId,
        productId: product.id,
        title: sv.title ?? (variants.length === 1 ? 'Default Title' : `Option ${i + 1}`),
        sku,
        inventoryItemId: itemId,
        metafields: [],
        createdAt: now,
        updatedAt: now,
      };
      const item: InventoryItem = { id: itemId, variantId, sku, tracked: sv.tracked ?? true };
      this.variants.set(variantId, variant);
      this.items.set(itemId, item);
      product.variantIds.push(variantId);
      outV.push(variant);
      outI.push(item);
      for (const [locationId, available] of Object.entries(sv.stock ?? {})) {
        this.ensureLevel(itemId, locationId).q.available = available;
      }
    });
    return { product, variants: outV, items: outI };
  }

  // ---- lookups -----------------------------------------------------------------------------

  order(id: string): Order {
    const o = this.orders.get(id);
    if (!o) throw new Error(`Unknown order ${id}`);
    return o;
  }
  variant(id: string): Variant {
    const v = this.variants.get(id);
    if (!v) throw new Error(`Unknown variant ${id}`);
    return v;
  }
  itemOfVariant(variantId: string | null): InventoryItem | undefined {
    if (!variantId) return undefined;
    const v = this.variants.get(variantId);
    return v ? this.items.get(v.inventoryItemId) : undefined;
  }
  fulfillmentOrdersOf(orderId: string): FulfillmentOrder[] {
    return [...this.fulfillmentOrders.values()].filter((f) => f.orderId === orderId);
  }
  fulfillmentsOf(orderId: string): Fulfillment[] {
    return [...this.fulfillments.values()].filter((f) => f.orderId === orderId);
  }
  refundsOf(orderId: string): Refund[] {
    return [...this.refunds.values()].filter((r) => r.orderId === orderId);
  }
  returnsOf(orderId: string): Return[] {
    return [...this.returns.values()].filter((r) => r.orderId === orderId);
  }
  levelsOfItem(itemId: string): InventoryLevel[] {
    return [...this.levels.values()].filter((l) => l.itemId === itemId);
  }

  // ---- inventory primitives -----------------------------------------------------------------

  levelKey(itemId: string, locationId: string): string {
    return `${itemId}|${locationId}`;
  }

  getLevel(itemId: string, locationId: string): InventoryLevel | undefined {
    return this.levels.get(this.levelKey(itemId, locationId));
  }

  /** Creates the level when missing (active by default, inactive for API quantity writes since 2026-04). */
  ensureLevel(itemId: string, locationId: string, active = true): InventoryLevel {
    const key = this.levelKey(itemId, locationId);
    let level = this.levels.get(key);
    if (!level) {
      level = {
        id: `gid://shopify/InventoryLevel/${this.nextId('InventoryLevel').split('/').pop()}?inventory_item_id=${numericId(itemId)}`,
        itemId,
        locationId,
        isActive: active,
        q: zeroQuantities(),
        updatedAt: this.stamp(),
      };
      this.levels.set(key, level);
    }
    return level;
  }

  quantity(level: InventoryLevel, name: QuantityName): number {
    if (name === 'on_hand') return ON_HAND_COMPONENTS.reduce((s, n) => s + level.q[n], 0);
    return level.q[name];
  }

  /** Groups level changes so that one `inventory_levels/update` is emitted per level whose `available` moved. */
  batchLevels<T>(fn: () => T): T {
    this.batchDepth += 1;
    try {
      return fn();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0) {
        const before = this.batchBefore;
        this.batchBefore = new Map();
        for (const [key, was] of before) {
          const level = this.levels.get(key);
          if (level && level.q.available !== was) this.emitLevelUpdate(level);
        }
      }
    }
  }

  /** Raw change of one stored quantity; the single place where quantities move. */
  changeQuantity(itemId: string, locationId: string, name: StoredQuantityName, delta: number, opts: { activeIfCreated?: boolean } = {}): InventoryLevel {
    return this.batchLevels(() => {
      const level = this.ensureLevel(itemId, locationId, opts.activeIfCreated ?? true);
      const key = this.levelKey(itemId, locationId);
      if (!this.batchBefore.has(key)) this.batchBefore.set(key, level.q.available);
      level.q[name] += delta;
      level.updatedAt = this.stamp();
      return level;
    });
  }

  private emitLevelUpdate(level: InventoryLevel): void {
    this.emit('inventory_levels/update', {
      inventory_item_id: numericId(level.itemId),
      location_id: numericId(level.locationId),
      available: level.q.available,
      updated_at: level.updatedAt,
      admin_graphql_api_id: level.id,
    });
  }

  // Stock effects Shopify applies by itself (spec 7.2 "Shopify"), skipped for untracked items.

  private tracked(variantId: string | null): InventoryItem | undefined {
    const item = this.itemOfVariant(variantId);
    return item?.tracked ? item : undefined;
  }

  /** Order placed: available -> committed. */
  effectCommit(variantId: string | null, locationId: string, qty: number): void {
    const item = this.tracked(variantId);
    if (!item || qty === 0) return;
    this.batchLevels(() => {
      this.changeQuantity(item.id, locationId, 'available', -qty);
      this.changeQuantity(item.id, locationId, 'committed', qty);
    });
  }
  /** Unfulfilled quantity removed with restock: committed -> available. */
  effectRelease(variantId: string | null, locationId: string, qty: number): void {
    const item = this.tracked(variantId);
    if (!item || qty === 0) return;
    this.batchLevels(() => {
      this.changeQuantity(item.id, locationId, 'committed', -qty);
      this.changeQuantity(item.id, locationId, 'available', qty);
    });
  }
  /** Fulfilled, or removed without restock: committed leaves on_hand. */
  effectDiscard(variantId: string | null, locationId: string, qty: number): void {
    const item = this.tracked(variantId);
    if (!item || qty === 0) return;
    this.changeQuantity(item.id, locationId, 'committed', -qty);
  }
  /** Fulfillment cancelled: committed comes back. */
  effectRecommit(variantId: string | null, locationId: string, qty: number): void {
    const item = this.tracked(variantId);
    if (!item || qty === 0) return;
    this.changeQuantity(item.id, locationId, 'committed', qty);
  }
  /** Restocked on return/refund. */
  effectRestock(variantId: string | null, locationId: string, qty: number, name: StoredQuantityName = 'available'): void {
    const item = this.tracked(variantId);
    if (!item || qty === 0) return;
    this.changeQuantity(item.id, locationId, name, qty);
  }

  /** Bumps `updatedAt` of an order. */
  touchOrder(order: Order): void {
    order.updatedAt = this.stamp();
  }

  bulkOperation(id: string): BulkOperation {
    const b = this.bulkOperations.get(id);
    if (!b) throw new Error(`Unknown bulk operation ${id}`);
    return b;
  }
}
