import type {
  DispositionType,
  Fulfillment,
  FulfillmentOrder,
  LineItem,
  Order,
  Refund,
  RefundLine,
  RestockType,
  Return,
  ReverseFulfillmentOrder,
  StoredQuantityName,
} from './model.js';
import { fulfillmentOrderPayload, fulfillmentPayload, orderPayload, refundPayload, returnPayload, unfulfilledQuantity } from './payloads.js';
import type { Shop } from './shop.js';
import { numericId } from './util.js';

/** A line of an order, designated by its gid or by its index in `order.lines`. */
export type LineRef = string | number;

export interface MerchantOptions {
  /**
   * Stock effect of a `PROCESSING_REQUIRED` disposition. The real behaviour is gate PV-3 of the spec, so it is a switch:
   * `none` (Shopify adds nothing) or `available` (Shopify adds the unit to `available`).
   */
  processingRequiredStock?: 'none' | 'available';
  /** Add a `restock` flag to the removals of `orders/edited` (spec gate PV-14 is unresolved; default: absent). */
  editPayloadRestock?: boolean;
}

export interface NewOrderLine {
  variantId: string;
  quantity: number;
  /** Line item custom properties (`customAttributes`). */
  properties?: Record<string, string>;
  /** Fulfillment location for this line (default: order location, then first active location). */
  locationId?: string;
}

export interface NewOrder {
  lines: NewOrderLine[];
  locationId?: string;
  test?: boolean;
  /** `web` (default) or `pos`. */
  source?: string;
}

export interface PosSale {
  locationId: string;
  lines: (Omit<NewOrderLine, 'locationId' | 'properties'> & { properties?: Record<string, string>; units?: string[] })[];
  test?: boolean;
}

export interface FulfillInput {
  /** Restrict to these lines (default: everything left). */
  lines?: { line: LineRef; quantity?: number }[];
  /** Restrict to the fulfillment orders at this location. */
  locationId?: string;
  fulfillmentOrderId?: string;
}

export interface RefundInput {
  lines: { line: LineRef; quantity: number; restockType: RestockType; locationId?: string }[];
}

export interface DispositionInput {
  line: LineRef;
  quantity: number;
  disposition: DispositionType;
  locationId?: string;
}

/** Everything a merchant does in the admin; each action mutates the shop and emits the matching webhooks. */
export class Merchant {
  readonly shop: Shop;
  readonly options: Required<MerchantOptions>;

  constructor(shop: Shop, options: MerchantOptions = {}) {
    this.shop = shop;
    this.options = { processingRequiredStock: options.processingRequiredStock ?? 'none', editPayloadRestock: options.editPayloadRestock ?? false };
  }

  order(id: string): OrderHandle {
    this.shop.order(id);
    return new OrderHandle(this, id);
  }

  /** Online order: stock is committed, one fulfillment order per location, `orders/create` + `orders/updated`. */
  createOrder(input: NewOrder): OrderHandle {
    const order = this.buildOrder(input);
    const shop = this.shop;
    shop.emit('orders/create', orderPayload(shop, order));
    for (const fo of shop.fulfillmentOrdersOf(order.id)) shop.emit('fulfillment_orders/order_routing_complete', { fulfillment_order: fulfillmentOrderPayload(fo) });
    shop.emit('orders/updated', orderPayload(shop, order));
    return new OrderHandle(this, order.id);
  }

  /** POS sale: the order arrives already fulfilled. A line may carry `units` (written as `_serialis_units`, comma separated). */
  posSale(input: PosSale): OrderHandle {
    const lines: NewOrderLine[] = input.lines.map((l) => {
      const properties = { ...(l.properties ?? {}) };
      if (l.units) properties['_serialis_units'] = l.units.join(',');
      return { variantId: l.variantId, quantity: l.quantity, properties };
    });
    const shop = this.shop;
    const order = this.buildOrder({ lines, locationId: input.locationId, source: 'pos', test: input.test ?? false });
    order.retailLocationId = input.locationId;
    const fulfillments = this.fulfillInternal(order, {});
    shop.touchOrder(order);
    shop.emit('orders/create', orderPayload(shop, order));
    for (const f of fulfillments) shop.emit('fulfillments/create', fulfillmentPayload(f));
    shop.emit('orders/updated', orderPayload(shop, order));
    return new OrderHandle(this, order.id);
  }

  /** Manual stock change made in the admin (webhook `inventory_levels/update` when `available` moves). */
  adjustInventory(input: { itemId?: string; variantId?: string; locationId: string; delta: number; name?: StoredQuantityName }): void {
    const itemId = input.itemId ?? this.shop.variant(input.variantId ?? '').inventoryItemId;
    if (!this.shop.items.has(itemId)) throw new Error(`Unknown inventory item ${itemId}`);
    this.shop.changeQuantity(itemId, input.locationId, input.name ?? 'available', input.delta);
  }

  /** Sets `available` to an absolute value (a stocktake). */
  setAvailable(input: { itemId?: string; variantId?: string; locationId: string; quantity: number }): void {
    const itemId = input.itemId ?? this.shop.variant(input.variantId ?? '').inventoryItemId;
    const level = this.shop.ensureLevel(itemId, input.locationId);
    this.shop.changeQuantity(itemId, input.locationId, 'available', input.quantity - level.q.available);
  }

  deactivateLocation(locationId: string): void {
    const loc = this.shop.locations.get(locationId);
    if (!loc) throw new Error(`Unknown location ${locationId}`);
    loc.isActive = false;
    this.shop.emit('locations/deactivate', { id: numericId(loc.id), admin_graphql_api_id: loc.id, name: loc.name, active: false });
  }

  /** Turns stock tracking off for the variant's inventory item (`inventory_items/update`). */
  untrackVariant(variantId: string): void {
    const item = this.shop.itemOfVariant(variantId);
    if (!item) throw new Error(`Unknown variant ${variantId}`);
    item.tracked = false;
    this.shop.emit('inventory_items/update', { id: numericId(item.id), admin_graphql_api_id: item.id, sku: item.sku, tracked: false });
  }

  deleteProduct(productId: string): void {
    const product = this.shop.products.get(productId);
    if (!product) throw new Error(`Unknown product ${productId}`);
    for (const vid of product.variantIds) this.shop.variants.delete(vid);
    this.shop.products.delete(productId);
    this.shop.emit('products/delete', { id: numericId(productId) });
  }

  uninstallApp(): void {
    this.shop.emit('app/uninstalled', { id: 1, domain: this.shop.domain, myshopify_domain: this.shop.domain });
  }

  // ---- internals shared with OrderHandle ----------------------------------------------------

  lineOf(order: Order, ref: LineRef): LineItem {
    const line = typeof ref === 'number' ? order.lines[ref] : order.lines.find((l) => l.id === ref);
    if (!line) throw new Error(`No line ${String(ref)} on order ${order.id}`);
    return line;
  }

  private defaultLocation(): string {
    const loc = [...this.shop.locations.values()].find((l) => l.isActive);
    if (!loc) throw new Error('The shop has no active location');
    return loc.id;
  }

  buildOrder(input: NewOrder): Order {
    const shop = this.shop;
    const now = shop.stamp();
    const number = shop.nextOrderNumber();
    const order: Order = {
      id: shop.nextId('Order'),
      name: `#${number}`,
      createdAt: now,
      updatedAt: now,
      cancelledAt: null,
      cancelReason: null,
      closedAt: null,
      test: input.test ?? false,
      sourceName: input.source ?? 'web',
      retailLocationId: null,
      lines: [],
      metafields: [],
    };
    shop.orders.set(order.id, order);
    const byLocation = new Map<string, LineItem[]>();
    const orderLocation = input.locationId ?? this.defaultLocation();
    for (const nl of input.lines) {
      const variant = shop.variants.get(nl.variantId);
      if (!variant) throw new Error(`Unknown variant ${nl.variantId}`);
      const line: LineItem = {
        id: shop.nextId('LineItem'),
        variantId: variant.id,
        title: `${shop.products.get(variant.productId)?.title ?? 'Product'} - ${variant.title}`,
        quantity: nl.quantity,
        currentQuantity: nl.quantity,
        fulfilledQuantity: 0,
        customAttributes: Object.entries(nl.properties ?? {}).map(([key, value]) => ({ key, value })),
      };
      order.lines.push(line);
      const loc = nl.locationId ?? orderLocation;
      const list = byLocation.get(loc) ?? [];
      list.push(line);
      byLocation.set(loc, list);
      shop.effectCommit(variant.id, loc, nl.quantity);
    }
    for (const [locationId, lines] of byLocation) this.createFulfillmentOrder(order, locationId, lines.map((l) => ({ lineItemId: l.id, quantity: l.quantity })));
    return order;
  }

  createFulfillmentOrder(order: Order, locationId: string, lines: { lineItemId: string; quantity: number }[]): FulfillmentOrder {
    const shop = this.shop;
    const now = shop.stamp();
    const fo: FulfillmentOrder = {
      id: shop.nextId('FulfillmentOrder'),
      orderId: order.id,
      status: 'OPEN',
      locationId,
      lines: lines.map((l) => ({ id: shop.nextId('FulfillmentOrderLineItem'), lineItemId: l.lineItemId, totalQuantity: l.quantity, remainingQuantity: l.quantity })),
      holds: [],
      fulfillAt: null,
      createdAt: now,
      updatedAt: now,
    };
    shop.fulfillmentOrders.set(fo.id, fo);
    return fo;
  }

  /** Fulfils (state and stock only, no webhook) and returns the fulfillments created. */
  fulfillInternal(order: Order, input: FulfillInput): Fulfillment[] {
    const shop = this.shop;
    const wanted = input.lines?.map((l) => ({ lineItemId: this.lineOf(order, l.line).id, quantity: l.quantity }));
    const out: Fulfillment[] = [];
    const left = new Map<string, number | undefined>(wanted?.map((w) => [w.lineItemId, w.quantity]));
    for (const fo of shop.fulfillmentOrdersOf(order.id)) {
      if (input.fulfillmentOrderId && fo.id !== input.fulfillmentOrderId) continue;
      if (input.locationId && fo.locationId !== input.locationId) continue;
      if (fo.status === 'CLOSED' || fo.status === 'CANCELLED') continue;
      const picks: { lineItemId: string; quantity: number }[] = [];
      for (const fl of fo.lines) {
        if (fl.remainingQuantity === 0) continue;
        if (wanted && !left.has(fl.lineItemId)) continue;
        const cap = left.get(fl.lineItemId);
        const qty = cap === undefined ? fl.remainingQuantity : Math.min(cap, fl.remainingQuantity);
        if (qty <= 0) continue;
        picks.push({ lineItemId: fl.lineItemId, quantity: qty });
        if (cap !== undefined) left.set(fl.lineItemId, cap - qty);
      }
      if (picks.length === 0) continue;
      if (fo.status === 'ON_HOLD') throw new Error(`Fulfillment order ${fo.id} is on hold`);
      if (fo.status === 'SCHEDULED') throw new Error(`Fulfillment order ${fo.id} is scheduled`);
      const now = shop.stamp();
      const fulfillment: Fulfillment = {
        id: shop.nextId('Fulfillment'),
        orderId: order.id,
        fulfillmentOrderId: fo.id,
        locationId: fo.locationId,
        status: 'SUCCESS',
        lines: picks,
        createdAt: now,
        updatedAt: now,
      };
      shop.fulfillments.set(fulfillment.id, fulfillment);
      for (const p of picks) {
        const fl = fo.lines.find((l) => l.lineItemId === p.lineItemId);
        const line = this.lineOf(order, p.lineItemId);
        if (fl) fl.remainingQuantity -= p.quantity;
        line.fulfilledQuantity += p.quantity;
        shop.effectDiscard(line.variantId, fo.locationId, p.quantity);
      }
      fo.status = fo.lines.every((l) => l.remainingQuantity === 0) ? 'CLOSED' : 'IN_PROGRESS';
      fo.updatedAt = now;
      out.push(fulfillment);
    }
    for (const [lineItemId, remaining] of left) {
      if (remaining !== undefined && remaining > 0) throw new Error(`Cannot fulfil ${remaining} more of line ${lineItemId}: not enough fulfillable quantity`);
    }
    if (out.length === 0) throw new Error('Nothing to fulfil');
    return out;
  }

  /**
   * Removes up to `amount` unfulfilled units of a line from its open fulfillment orders. Returns the amounts taken per
   * location. Stock is not touched.
   */
  takeUnfulfilled(order: Order, line: LineItem, amount: number): { locationId: string; quantity: number }[] {
    if (amount > unfulfilledQuantity(line)) throw new Error(`Line ${line.id}: only ${unfulfilledQuantity(line)} unfulfilled, cannot remove ${amount}`);
    const taken: { locationId: string; quantity: number }[] = [];
    let todo = amount;
    const fos = this.shop.fulfillmentOrdersOf(order.id).filter((f) => f.status !== 'CLOSED' && f.status !== 'CANCELLED').reverse();
    for (const fo of fos) {
      const fl = fo.lines.find((l) => l.lineItemId === line.id);
      if (!fl || fl.remainingQuantity === 0 || todo === 0) continue;
      const q = Math.min(todo, fl.remainingQuantity);
      fl.remainingQuantity -= q;
      fl.totalQuantity -= q;
      todo -= q;
      fo.updatedAt = this.shop.stamp();
      if (fo.lines.every((l) => l.remainingQuantity === 0)) fo.status = 'CLOSED';
      taken.push({ locationId: fo.locationId, quantity: q });
    }
    line.currentQuantity -= amount;
    return taken;
  }

  fulfilledLocation(order: Order, line: LineItem): string {
    const f = this.shop.fulfillmentsOf(order.id).find((x) => x.lines.some((l) => l.lineItemId === line.id));
    return f?.locationId ?? order.retailLocationId ?? this.shop.fulfillmentOrdersOf(order.id)[0]?.locationId ?? this.defaultLocation();
  }

  reverseOrderOf(ret: Return): ReverseFulfillmentOrder {
    const rfo = ret.reverseFulfillmentOrders[0];
    if (!rfo) throw new Error(`Return ${ret.id} has no reverse fulfillment order yet (not approved)`);
    return rfo;
  }
}

export interface EditRemoval {
  line: LineRef;
  quantity: number;
  restock: boolean;
}

/** Order edit session (`order.edit()`): operations are applied, and `orders/edited` emitted, on `commit()`. */
export class OrderEdit {
  private ops: (() => { addition?: LineItem; removal?: { line: LineItem; delta: number; restock: boolean } })[] = [];
  constructor(
    private readonly merchant: Merchant,
    private readonly orderId: string,
  ) {}

  /** Removes every unfulfilled unit of the line. `restock` defaults to true. */
  removeLine(line: LineRef, opts: { restock?: boolean } = {}): this {
    return this.reduceLine(line, { to: 0 }, opts);
  }

  /** Reduces the line by `by` units, or down to `to` units. */
  reduceLine(line: LineRef, amount: { by: number } | { to: number }, opts: { restock?: boolean } = {}): this {
    this.ops.push(() => {
      const shop = this.merchant.shop;
      const order = shop.order(this.orderId);
      const li = this.merchant.lineOf(order, line);
      const by = 'by' in amount ? amount.by : li.currentQuantity - amount.to;
      if (by <= 0) throw new Error('Nothing to remove');
      const restock = opts.restock ?? true;
      for (const t of this.merchant.takeUnfulfilled(order, li, by)) {
        if (restock) shop.effectRelease(li.variantId, t.locationId, t.quantity);
        else shop.effectDiscard(li.variantId, t.locationId, t.quantity);
      }
      return { removal: { line: li, delta: by, restock } };
    });
    return this;
  }

  addLine(input: { variantId: string; quantity: number; properties?: Record<string, string>; locationId?: string }): this {
    this.ops.push(() => {
      const shop = this.merchant.shop;
      const order = shop.order(this.orderId);
      const variant = shop.variants.get(input.variantId);
      if (!variant) throw new Error(`Unknown variant ${input.variantId}`);
      const line: LineItem = {
        id: shop.nextId('LineItem'),
        variantId: variant.id,
        title: `${shop.products.get(variant.productId)?.title ?? 'Product'} - ${variant.title}`,
        quantity: input.quantity,
        currentQuantity: input.quantity,
        fulfilledQuantity: 0,
        customAttributes: Object.entries(input.properties ?? {}).map(([key, value]) => ({ key, value })),
      };
      order.lines.push(line);
      const fos = shop.fulfillmentOrdersOf(order.id);
      const locationId = input.locationId ?? order.retailLocationId ?? fos[0]?.locationId ?? [...shop.locations.values()].find((l) => l.isActive)?.id;
      if (!locationId) throw new Error('No location for the added line');
      const open = fos.find((f) => f.locationId === locationId && (f.status === 'OPEN' || f.status === 'IN_PROGRESS'));
      if (open) {
        open.lines.push({ id: shop.nextId('FulfillmentOrderLineItem'), lineItemId: line.id, totalQuantity: line.quantity, remainingQuantity: line.quantity });
        open.status = open.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'OPEN';
        open.updatedAt = shop.stamp();
      } else {
        this.merchant.createFulfillmentOrder(order, locationId, [{ lineItemId: line.id, quantity: line.quantity }]);
      }
      shop.effectCommit(variant.id, locationId, line.quantity);
      return { addition: line };
    });
    return this;
  }

  /** Applies the edit and emits `orders/edited` then `orders/updated`. */
  commit(): OrderHandle {
    const shop = this.merchant.shop;
    const order = shop.order(this.orderId);
    const additions: Record<string, unknown>[] = [];
    const removals: Record<string, unknown>[] = [];
    for (const op of this.ops) {
      const r = op();
      if (r.addition) additions.push({ id: numericId(r.addition.id), delta: r.addition.quantity, title: r.addition.title, variant_id: r.addition.variantId ? numericId(r.addition.variantId) : null });
      if (r.removal) {
        const rem: Record<string, unknown> = { id: numericId(r.removal.line.id), delta: r.removal.delta, title: r.removal.line.title };
        if (this.merchant.options.editPayloadRestock) rem['restock'] = r.removal.restock;
        removals.push(rem);
      }
    }
    this.ops = [];
    shop.touchOrder(order);
    shop.emit('orders/edited', { order_edit: { id: numericId(shop.nextId('OrderEdit')), order_id: numericId(order.id), committed_at: order.updatedAt, line_items: { additions, removals } } });
    shop.emit('orders/updated', orderPayload(shop, order));
    return new OrderHandle(this.merchant, order.id);
  }
}

/** Fluent handle on one order. Action methods return the handle; read `returns`, `refunds`, ... for what was created. */
export class OrderHandle {
  constructor(
    private readonly merchant: Merchant,
    readonly id: string,
  ) {}

  private get shop(): Shop {
    return this.merchant.shop;
  }

  get data(): Order {
    return this.shop.order(this.id);
  }
  get lines(): LineItem[] {
    return this.data.lines;
  }
  get fulfillmentOrders(): FulfillmentOrder[] {
    return this.shop.fulfillmentOrdersOf(this.id);
  }
  get fulfillments(): Fulfillment[] {
    return this.shop.fulfillmentsOf(this.id);
  }
  get refunds(): Refund[] {
    return this.shop.refundsOf(this.id);
  }
  get returns(): Return[] {
    return this.shop.returnsOf(this.id);
  }

  edit(): OrderEdit {
    return new OrderEdit(this.merchant, this.id);
  }

  /** Cancels the order. `restock` (default true) decides CANCEL vs NO_RESTOCK; `refund: false` cancels without any refund record. */
  cancel(opts: { restock?: boolean; refund?: boolean; reason?: string } = {}): this {
    const shop = this.shop;
    const order = this.data;
    if (order.cancelledAt) throw new Error(`Order ${order.id} is already cancelled`);
    const restock = opts.restock ?? true;
    const refundLines: RefundLine[] = [];
    for (const line of order.lines) {
      const amount = unfulfilledQuantity(line);
      if (amount === 0) continue;
      for (const t of this.merchant.takeUnfulfilled(order, line, amount)) {
        if (restock) shop.effectRelease(line.variantId, t.locationId, t.quantity);
        else shop.effectDiscard(line.variantId, t.locationId, t.quantity);
        refundLines.push({ id: shop.nextId('RefundLineItem'), lineItemId: line.id, quantity: t.quantity, restockType: restock ? 'CANCEL' : 'NO_RESTOCK', locationId: t.locationId });
      }
    }
    const cancelledFos: FulfillmentOrder[] = [];
    for (const fo of this.fulfillmentOrders) {
      if (fo.status === 'CLOSED' || fo.status === 'CANCELLED') continue;
      fo.status = this.fulfillments.some((f) => f.fulfillmentOrderId === fo.id) ? 'CLOSED' : 'CANCELLED';
      fo.updatedAt = shop.stamp();
      cancelledFos.push(fo);
    }
    // takeUnfulfilled marks emptied orders CLOSED; cancellation turns the never-fulfilled ones into CANCELLED.
    for (const fo of this.fulfillmentOrders) {
      if (fo.status === 'CLOSED' && !this.fulfillments.some((f) => f.fulfillmentOrderId === fo.id)) {
        fo.status = 'CANCELLED';
        if (!cancelledFos.includes(fo)) cancelledFos.push(fo);
      }
    }
    const now = shop.stamp();
    order.cancelledAt = now;
    order.cancelReason = opts.reason ?? 'CUSTOMER';
    order.closedAt = now;
    shop.touchOrder(order);
    if ((opts.refund ?? true) && refundLines.length > 0) {
      const refund: Refund = { id: shop.nextId('Refund'), orderId: order.id, createdAt: now, lines: refundLines };
      shop.refunds.set(refund.id, refund);
      shop.emit('refunds/create', refundPayload(refund));
    }
    for (const fo of cancelledFos) shop.emit('fulfillment_orders/cancelled', { fulfillment_order: fulfillmentOrderPayload(fo), replacement_fulfillment_order: null });
    shop.emit('orders/cancelled', orderPayload(shop, order));
    shop.emit('orders/updated', orderPayload(shop, order));
    return this;
  }

  /**
   * Refunds lines. CANCEL / NO_RESTOCK first consume unfulfilled quantity (CANCEL requires it); RETURN restocks fulfilled
   * units at `locationId`; LEGACY_RESTOCK behaves as CANCEL for unfulfilled units and RETURN for the rest.
   */
  refund(input: RefundInput): this {
    const shop = this.shop;
    const order = this.data;
    const lines: RefundLine[] = [];
    for (const r of input.lines) {
      const line = this.merchant.lineOf(order, r.line);
      if (r.quantity <= 0 || r.quantity > line.currentQuantity) throw new Error(`Cannot refund ${r.quantity} of line ${line.id} (current ${line.currentQuantity})`);
      let fulfilledPart = r.quantity;
      if (r.restockType !== 'RETURN') {
        const unf = Math.min(r.quantity, unfulfilledQuantity(line));
        if (r.restockType === 'CANCEL' && unf < r.quantity) throw new Error('CANCEL restock needs unfulfilled quantity');
        fulfilledPart = r.quantity - unf;
        for (const t of this.merchant.takeUnfulfilled(order, line, unf)) {
          if (r.restockType === 'NO_RESTOCK') shop.effectDiscard(line.variantId, t.locationId, t.quantity);
          else shop.effectRelease(line.variantId, t.locationId, t.quantity);
          lines.push({ id: shop.nextId('RefundLineItem'), lineItemId: line.id, quantity: t.quantity, restockType: r.restockType === 'LEGACY_RESTOCK' ? 'LEGACY_RESTOCK' : r.restockType, locationId: t.locationId });
        }
      }
      if (fulfilledPart > 0) {
        if (fulfilledPart > line.fulfilledQuantity) throw new Error(`Cannot refund ${fulfilledPart} fulfilled units of ${line.id}`);
        const loc = r.locationId ?? this.merchant.fulfilledLocation(order, line);
        if (r.restockType === 'RETURN' || r.restockType === 'LEGACY_RESTOCK') shop.effectRestock(line.variantId, loc, fulfilledPart);
        line.currentQuantity -= fulfilledPart;
        line.fulfilledQuantity -= fulfilledPart;
        lines.push({ id: shop.nextId('RefundLineItem'), lineItemId: line.id, quantity: fulfilledPart, restockType: r.restockType, locationId: r.restockType === 'NO_RESTOCK' ? null : loc });
      }
    }
    const refund: Refund = { id: shop.nextId('Refund'), orderId: order.id, createdAt: shop.stamp(), lines };
    shop.refunds.set(refund.id, refund);
    shop.touchOrder(order);
    shop.emit('refunds/create', refundPayload(refund));
    shop.emit('orders/updated', orderPayload(shop, order));
    return this;
  }

  /** Partial or total fulfilment: `fulfillments/create` per fulfillment order touched, then `orders/updated`. */
  fulfill(input: FulfillInput = {}): this {
    const shop = this.shop;
    const created = this.merchant.fulfillInternal(this.data, input);
    shop.touchOrder(this.data);
    for (const f of created) shop.emit('fulfillments/create', fulfillmentPayload(f));
    shop.emit('orders/updated', orderPayload(shop, this.data));
    return this;
  }

  /** Cancels a fulfillment: quantities go back to the fulfillment order and to `committed`. */
  cancelFulfillment(fulfillmentId: string): this {
    const shop = this.shop;
    const f = shop.fulfillments.get(fulfillmentId);
    if (!f || f.orderId !== this.id) throw new Error(`Unknown fulfillment ${fulfillmentId}`);
    if (f.status === 'CANCELLED') throw new Error('Fulfillment already cancelled');
    const fo = shop.fulfillmentOrders.get(f.fulfillmentOrderId);
    for (const l of f.lines) {
      const line = this.merchant.lineOf(this.data, l.lineItemId);
      line.fulfilledQuantity -= l.quantity;
      const fl = fo?.lines.find((x) => x.lineItemId === l.lineItemId);
      if (fl) fl.remainingQuantity += l.quantity;
      shop.effectRecommit(line.variantId, f.locationId, l.quantity);
    }
    if (fo && fo.status !== 'CANCELLED') {
      const anyOther = shop.fulfillmentsOf(this.id).some((x) => x.id !== f.id && x.status === 'SUCCESS' && x.fulfillmentOrderId === fo.id);
      fo.status = anyOther ? 'IN_PROGRESS' : 'OPEN';
      fo.updatedAt = shop.stamp();
    }
    f.status = 'CANCELLED';
    f.updatedAt = shop.stamp();
    shop.touchOrder(this.data);
    shop.emit('fulfillments/update', fulfillmentPayload(f));
    shop.emit('orders/updated', orderPayload(shop, this.data));
    return this;
  }

  /**
   * Moves a fulfillment order (or part of it, with `lines`) to another location. The committed stock follows: released at
   * the source, committed at the destination. `fulfillment_orders/moved` is emitted.
   */
  moveFulfillmentOrder(foId: string, toLocationId: string, lines?: { line: LineRef; quantity: number }[]): this {
    const shop = this.shop;
    const fo = shop.fulfillmentOrders.get(foId);
    if (!fo || fo.orderId !== this.id) throw new Error(`Unknown fulfillment order ${foId}`);
    if (fo.status !== 'OPEN' && fo.status !== 'IN_PROGRESS') throw new Error(`Fulfillment order ${foId} is ${fo.status}, cannot be moved`);
    const dest = shop.locations.get(toLocationId);
    if (!dest?.isActive) throw new Error(`Location ${toLocationId} is not an active location`);
    if (toLocationId === fo.locationId) throw new Error('Destination equals source');
    const source = shop.locations.get(fo.locationId);
    const picks = lines
      ? lines.map((l) => ({ lineItemId: this.merchant.lineOf(this.data, l.line).id, quantity: l.quantity }))
      : fo.lines.filter((l) => l.remainingQuantity > 0).map((l) => ({ lineItemId: l.lineItemId, quantity: l.remainingQuantity }));
    const full = !lines || fo.lines.every((l) => picks.find((p) => p.lineItemId === l.lineItemId)?.quantity === l.remainingQuantity);
    shop.batchLevels(() => {
      for (const p of picks) {
        const fl = fo.lines.find((l) => l.lineItemId === p.lineItemId);
        if (!fl || p.quantity > fl.remainingQuantity) throw new Error(`Cannot move ${p.quantity} of ${p.lineItemId}`);
        const line = this.merchant.lineOf(this.data, p.lineItemId);
        shop.effectRelease(line.variantId, fo.locationId, p.quantity);
        shop.effectCommit(line.variantId, toLocationId, p.quantity);
      }
    });
    let moved: FulfillmentOrder;
    if (full) {
      fo.locationId = toLocationId;
      fo.updatedAt = shop.stamp();
      moved = fo;
    } else {
      for (const p of picks) {
        const fl = fo.lines.find((l) => l.lineItemId === p.lineItemId);
        if (fl) {
          fl.remainingQuantity -= p.quantity;
          fl.totalQuantity -= p.quantity;
        }
      }
      fo.updatedAt = shop.stamp();
      moved = this.merchant.createFulfillmentOrder(this.data, toLocationId, picks);
    }
    shop.touchOrder(this.data);
    shop.emit('fulfillment_orders/moved', {
      fulfillment_order: fulfillmentOrderPayload(moved),
      original_fulfillment_order: fulfillmentOrderPayload(fo),
      source_location: { id: numericId(fo.locationId === toLocationId ? (source?.id ?? fo.locationId) : fo.locationId), name: source?.name },
      destination_location_id: numericId(toLocationId),
    });
    return this;
  }

  /** Splits quantities off a fulfillment order into a new one at the same location (`fulfillment_orders/split`). */
  splitFulfillmentOrder(foId: string, lines: { line: LineRef; quantity: number }[]): this {
    const shop = this.shop;
    const fo = shop.fulfillmentOrders.get(foId);
    if (!fo || fo.orderId !== this.id) throw new Error(`Unknown fulfillment order ${foId}`);
    if (fo.status !== 'OPEN') throw new Error(`Fulfillment order ${foId} is ${fo.status}, cannot be split`);
    const picks = lines.map((l) => ({ lineItemId: this.merchant.lineOf(this.data, l.line).id, quantity: l.quantity }));
    for (const p of picks) {
      const fl = fo.lines.find((l) => l.lineItemId === p.lineItemId);
      if (!fl || p.quantity <= 0 || p.quantity > fl.remainingQuantity) throw new Error(`Cannot split ${p.quantity} of ${p.lineItemId}`);
      fl.remainingQuantity -= p.quantity;
      fl.totalQuantity -= p.quantity;
    }
    fo.lines = fo.lines.filter((l) => l.totalQuantity > 0);
    fo.updatedAt = shop.stamp();
    const created = this.merchant.createFulfillmentOrder(this.data, fo.locationId, picks);
    shop.touchOrder(this.data);
    shop.emit('fulfillment_orders/split', { fulfillment_order: fulfillmentOrderPayload(fo), remaining_fulfillment_order: fulfillmentOrderPayload(created), replacement_fulfillment_order: null });
    return this;
  }

  /** Merges open fulfillment orders of the same order and location into the first (`fulfillment_orders/merged`). */
  mergeFulfillmentOrders(foIds: string[]): this {
    const shop = this.shop;
    const fos = foIds.map((id) => shop.fulfillmentOrders.get(id));
    const [target, ...others] = fos;
    if (!target || others.some((o) => !o)) throw new Error('Unknown fulfillment order');
    for (const o of others) {
      if (!o || o.orderId !== this.id || o.locationId !== target.locationId || o.status !== 'OPEN') throw new Error('Fulfillment orders cannot be merged');
    }
    if (target.orderId !== this.id || target.status !== 'OPEN') throw new Error('Fulfillment orders cannot be merged');
    for (const o of others) {
      if (!o) continue;
      for (const l of o.lines) {
        const same = target.lines.find((x) => x.lineItemId === l.lineItemId);
        if (same) {
          same.totalQuantity += l.totalQuantity;
          same.remainingQuantity += l.remainingQuantity;
        } else target.lines.push(l);
      }
      o.lines = [];
      o.status = 'CLOSED';
      o.updatedAt = shop.stamp();
    }
    target.updatedAt = shop.stamp();
    shop.touchOrder(this.data);
    shop.emit('fulfillment_orders/merged', { fulfillment_order: fulfillmentOrderPayload(target), merged_fulfillment_order_ids: others.map((o) => (o ? numericId(o.id) : 0)) });
    return this;
  }

  /** Customer-requested (`requested: true`, status REQUESTED) or merchant-created (OPEN, reverse fulfillment order at once) return. Emits `returns/request`. */
  createReturn(input: { lines: { line: LineRef; quantity: number; reason?: string }[]; requested?: boolean }): this {
    const shop = this.shop;
    const order = this.data;
    const lines = input.lines.map((l) => {
      const line = this.merchant.lineOf(order, l.line);
      const already = this.returns
        .filter((r) => r.status === 'REQUESTED' || r.status === 'OPEN' || r.status === 'CLOSED')
        .flatMap((r) => r.lines)
        .filter((rl) => rl.lineItemId === line.id)
        .reduce((s, rl) => s + rl.quantity, 0);
      if (l.quantity <= 0 || l.quantity + already > line.fulfilledQuantity) throw new Error(`Cannot return ${l.quantity} of ${line.id}: ${line.fulfilledQuantity} fulfilled, ${already} already in returns`);
      return { id: shop.nextId('ReturnLineItem'), lineItemId: line.id, quantity: l.quantity, returnReason: l.reason ?? 'UNKNOWN' };
    });
    const ret: Return = {
      id: shop.nextId('Return'),
      orderId: order.id,
      name: `${order.name}-R${this.returns.length + 1}`,
      status: input.requested ? 'REQUESTED' : 'OPEN',
      lines,
      reverseFulfillmentOrders: [],
      createdAt: shop.stamp(),
    };
    shop.returns.set(ret.id, ret);
    if (!input.requested) this.openReverse(ret);
    shop.touchOrder(order);
    shop.emit('returns/request', returnPayload(ret));
    return this;
  }

  private openReverse(ret: Return): void {
    ret.reverseFulfillmentOrders.push({
      id: this.shop.nextId('ReverseFulfillmentOrder'),
      returnId: ret.id,
      status: 'OPEN',
      lines: ret.lines.map((l) => ({ id: this.shop.nextId('ReverseFulfillmentOrderLineItem'), returnLineId: l.id, lineItemId: l.lineItemId, totalQuantity: l.quantity, dispositions: [] })),
    });
  }

  private returnById(id: string): Return {
    const r = this.shop.returns.get(id);
    if (!r || r.orderId !== this.id) throw new Error(`Unknown return ${id}`);
    return r;
  }

  private setReturnStatus(id: string, from: Return['status'][], to: Return['status'], topic: string): Return {
    const ret = this.returnById(id);
    if (!from.includes(ret.status)) throw new Error(`Return ${id} is ${ret.status}, expected ${from.join('/')}`);
    ret.status = to;
    this.shop.touchOrder(this.data);
    this.shop.emit(topic, returnPayload(ret));
    return ret;
  }

  approveReturn(id: string): this {
    const ret = this.returnById(id);
    if (ret.status !== 'REQUESTED') throw new Error(`Return ${id} is ${ret.status}, expected REQUESTED`);
    this.openReverse(ret);
    this.setReturnStatus(id, ['REQUESTED'], 'OPEN', 'returns/approve');
    return this;
  }
  declineReturn(id: string): this {
    this.setReturnStatus(id, ['REQUESTED'], 'DECLINED', 'returns/decline');
    return this;
  }
  cancelReturn(id: string): this {
    this.setReturnStatus(id, ['REQUESTED', 'OPEN'], 'CANCELED', 'returns/cancel');
    return this;
  }
  closeReturn(id: string): this {
    const ret = this.setReturnStatus(id, ['OPEN'], 'CLOSED', 'returns/close');
    for (const r of ret.reverseFulfillmentOrders) r.status = 'CLOSED';
    return this;
  }

  /**
   * Records dispositions on the reverse fulfillment order (reverse_fulfillment_orders/dispose, then returns/update).
   * RESTOCKED adds to `available` at the location; PROCESSING_REQUIRED follows `MerchantOptions.processingRequiredStock`.
   */
  dispose(returnId: string, dispositions: DispositionInput[]): this {
    const shop = this.shop;
    const ret = this.returnById(returnId);
    if (ret.status !== 'OPEN') throw new Error(`Return ${returnId} is ${ret.status}, dispositions need OPEN`);
    const rfo = this.merchant.reverseOrderOf(ret);
    const done: { id: string; line_item_id: number; disposition_type: string; quantity: number; location_id: number | null }[] = [];
    for (const d of dispositions) {
      const line = this.merchant.lineOf(this.data, d.line);
      const rl = rfo.lines.find((l) => l.lineItemId === line.id);
      if (!rl) throw new Error(`Line ${line.id} is not part of return ${returnId}`);
      const disposed = rl.dispositions.reduce((s, x) => s + x.quantity, 0);
      if (d.quantity <= 0 || disposed + d.quantity > rl.totalQuantity) throw new Error(`Cannot dispose ${d.quantity} of ${line.id}: ${disposed}/${rl.totalQuantity} already disposed`);
      const locationId = d.locationId ?? this.merchant.fulfilledLocation(this.data, line);
      rl.dispositions.push({ type: d.disposition, quantity: d.quantity, locationId: d.disposition === 'RESTOCKED' || d.disposition === 'PROCESSING_REQUIRED' ? locationId : null });
      if (d.disposition === 'RESTOCKED') shop.effectRestock(line.variantId, locationId, d.quantity);
      if (d.disposition === 'PROCESSING_REQUIRED' && this.merchant.options.processingRequiredStock === 'available') shop.effectRestock(line.variantId, locationId, d.quantity);
      done.push({ id: rl.id, line_item_id: numericId(line.id), disposition_type: d.disposition.toLowerCase(), quantity: d.quantity, location_id: numericId(locationId) });
    }
    if (rfo.lines.every((l) => l.dispositions.reduce((s, x) => s + x.quantity, 0) === l.totalQuantity)) rfo.status = 'CLOSED';
    shop.touchOrder(this.data);
    shop.emit('reverse_fulfillment_orders/dispose', {
      admin_graphql_api_id: rfo.id,
      return: { admin_graphql_api_id: ret.id },
      order: { admin_graphql_api_id: this.id },
      reverse_fulfillment_order_line_items: done,
    });
    shop.emit('returns/update', returnPayload(ret));
    return this;
  }
}
