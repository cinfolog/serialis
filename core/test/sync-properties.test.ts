import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { DispositionType, OrderSnapshot, RefundSnapshot, ReturnSnapshot } from '../src/snapshot.js';
import type { SyncState } from '../src/sync/plan.js';
import { LOC_A, LOC_B, T0, item, state, sync, unit } from './fixtures.js';

/**
 * Property-based tests (spec 18.3): a small Shopify simulator applies random sequences of
 * order events; after every event the order is synchronized and we check idempotence
 * (T-IDEM-01, inside `sync`), G1 (no unit engaged twice), "allocated never exceeds ordered",
 * and the unit ↔ allocation consistency rule of 11.2.
 */

const ITEMS = [item(1), item(2)];
const LOCS = [LOC_A, LOC_B];

interface SimLine {
  readonly n: number;
  readonly variant: 1 | 2;
  readonly quantity: number;
  current: number;
  foLoc: string;
  foVersion: number;
  remaining: number;
  fulfillments: { id: number; loc: string; qty: number; cancelled: boolean; at: number }[];
  returns: { id: number; disposition: DispositionType; loc: string }[];
}

interface SimOrder {
  readonly gid: string;
  readonly lines: SimLine[];
  refunds: RefundSnapshot[];
  edits: { lineItemGid: string; quantity: number; restock: boolean | null }[];
  cancelledAt: number | null;
  metafield: string | null;
}

type Op =
  | { kind: 'fulfill'; order: number; line: number; qty: number }
  | { kind: 'cancelFulfillment'; order: number; line: number }
  | { kind: 'reduce'; order: number; line: number; qty: number; restock: 'refund' | 'norestock' | 'edit' | 'unknown' }
  | { kind: 'move'; order: number; line: number }
  | { kind: 'cancelOrder'; order: number; restock: boolean }
  | { kind: 'receive'; item: number; loc: number }
  | { kind: 'return'; order: number; line: number; disposition: DispositionType; identify: boolean };

const lineArb = fc.record({ variant: fc.constantFrom<1 | 2>(1, 2), quantity: fc.integer({ min: 1, max: 4 }), loc: fc.integer({ min: 0, max: 1 }) });
const orderArb = fc.array(lineArb, { minLength: 1, maxLength: 2 });
const idx = fc.integer({ min: 0, max: 1 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('fulfill' as const), order: idx, line: idx, qty: fc.integer({ min: 1, max: 4 }) }),
  fc.record({ kind: fc.constant('cancelFulfillment' as const), order: idx, line: idx }),
  fc.record({
    kind: fc.constant('reduce' as const),
    order: idx,
    line: idx,
    qty: fc.integer({ min: 1, max: 3 }),
    restock: fc.constantFrom('refund' as const, 'norestock' as const, 'edit' as const, 'unknown' as const),
  }),
  fc.record({ kind: fc.constant('move' as const), order: idx, line: idx }),
  fc.record({ kind: fc.constant('cancelOrder' as const), order: idx, restock: fc.boolean() }),
  fc.record({ kind: fc.constant('receive' as const), item: idx, loc: idx }),
  fc.record({
    kind: fc.constant('return' as const),
    order: idx,
    line: idx,
    disposition: fc.constantFrom<DispositionType>('RESTOCKED', 'PROCESSING_REQUIRED', 'NOT_RESTOCKED', 'MISSING'),
    identify: fc.boolean(),
  }),
);
const scenarioArb = fc.record({
  stock: fc.array(fc.record({ item: idx, loc: idx }), { maxLength: 8 }),
  orders: fc.array(orderArb, { minLength: 1, maxLength: 2 }),
  ops: fc.array(opArb, { maxLength: 12 }),
});

const lineGid = (n: number) => `gid://shopify/LineItem/${n}`;
const fulfilledQty = (l: SimLine) => l.fulfillments.filter((f) => !f.cancelled).reduce((s, f) => s + f.qty, 0);

function snapshotOf(o: SimOrder): OrderSnapshot {
  const returns: ReturnSnapshot[] = o.lines.flatMap((l) =>
    l.returns.map((r) => {
      const rl = `gid://shopify/ReturnLineItem/${r.id}`;
      return {
        gid: `gid://shopify/Return/${r.id}`,
        status: 'CLOSED' as const,
        lineItems: [{ gid: rl, lineItemGid: lineGid(l.n), quantity: 1 }],
        dispositions: [{ returnLineItemGid: rl, type: r.disposition, quantity: 1, locationId: r.loc }],
      };
    }),
  );
  return {
    orderGid: o.gid,
    name: o.gid,
    createdAt: T0,
    updatedAt: T0,
    cancelledAt: o.cancelledAt,
    test: false,
    channel: 'online_store',
    retailLocationId: null,
    metafieldValue: o.metafield,
    lineItems: o.lines.map((l) => ({
      gid: lineGid(l.n),
      variantGid: ITEMS[l.variant - 1]!.variantGid,
      quantity: l.quantity,
      currentQuantity: l.current,
      serialisUnitsProperty: null,
    })),
    fulfillmentOrders: o.lines.map((l) => ({
      gid: `gid://shopify/FulfillmentOrder/${l.n}-${l.foVersion}`,
      status: l.remaining > 0 && o.cancelledAt === null ? ('OPEN' as const) : ('CLOSED' as const),
      locationId: l.foLoc,
      lineItems: [{ gid: `gid://shopify/FulfillmentOrderLineItem/${l.n}-${l.foVersion}`, lineItemGid: lineGid(l.n), totalQuantity: l.current, remainingQuantity: l.remaining }],
    })),
    fulfillments: o.lines.flatMap((l) =>
      l.fulfillments.map((f) => ({
        gid: `gid://shopify/Fulfillment/${f.id}`,
        status: f.cancelled ? ('CANCELLED' as const) : ('SUCCESS' as const),
        locationId: f.loc,
        createdAt: f.at,
        lineItems: [{ lineItemGid: lineGid(l.n), quantity: f.qty }],
      })),
    ),
    refunds: o.refunds,
    edits: o.edits,
    returns,
  };
}

/** Applies a Shopify-side event; returns the order to sync, or null for a receipt. */
function applyOp(op: Op, orders: SimOrder[], s: SyncState, seq: { n: number; clock: number }): { order: SimOrder | null; state: SyncState } {
  if (op.kind === 'receive') {
    const id = `r${seq.n++}`;
    return { order: null, state: { ...s, units: [...s.units, unit(id, ITEMS[op.item]!.id, LOCS[op.loc]!, { receivedAt: T0 + seq.n })] } };
  }
  const o = orders[op.order % orders.length]!;
  if (op.kind === 'cancelOrder') {
    if (o.cancelledAt === null) {
      o.cancelledAt = T0 + seq.n++;
      const lines = o.lines.filter((l) => l.remaining > 0);
      if (lines.length > 0) {
        o.refunds.push({
          gid: `gid://shopify/Refund/${seq.n++}`,
          createdAt: T0,
          lineItems: lines.map((l) => ({ lineItemGid: lineGid(l.n), quantity: l.remaining, restockType: op.restock ? 'CANCEL' : 'NO_RESTOCK', locationId: l.foLoc })),
        });
      }
      for (const l of lines) {
        l.current -= l.remaining;
        l.remaining = 0;
      }
    }
    return { order: o, state: s };
  }
  const l = o.lines[op.line % o.lines.length]!;
  let next = s;
  switch (op.kind) {
    case 'fulfill': {
      const q = Math.min(op.qty, l.remaining);
      if (q > 0 && o.cancelledAt === null) {
        l.remaining -= q;
        l.fulfillments.push({ id: seq.n++, loc: l.foLoc, qty: q, cancelled: false, at: seq.clock });
      }
      break;
    }
    case 'cancelFulfillment': {
      const f = [...l.fulfillments].reverse().find((x) => !x.cancelled);
      if (f && l.returns.length === 0 && o.cancelledAt === null && f.loc === l.foLoc) {
        f.cancelled = true;
        l.remaining += f.qty;
      }
      break;
    }
    case 'reduce': {
      const q = Math.min(op.qty, l.remaining);
      if (q > 0 && o.cancelledAt === null) {
        l.remaining -= q;
        l.current -= q;
        if (op.restock === 'refund' || op.restock === 'norestock') {
          o.refunds.push({
            gid: `gid://shopify/Refund/${seq.n++}`,
            createdAt: T0,
            lineItems: [{ lineItemGid: lineGid(l.n), quantity: q, restockType: op.restock === 'refund' ? 'CANCEL' : 'NO_RESTOCK', locationId: l.foLoc }],
          });
        } else {
          o.edits.push({ lineItemGid: lineGid(l.n), quantity: q, restock: op.restock === 'edit' ? true : null });
        }
      }
      break;
    }
    case 'move': {
      if (l.remaining > 0 && o.cancelledAt === null) {
        l.foLoc = l.foLoc === LOC_A ? LOC_B : LOC_A;
        l.foVersion++;
      }
      break;
    }
    case 'return': {
      if (l.returns.length < fulfilledQty(l)) {
        const id = seq.n++;
        l.returns.push({ id, disposition: op.disposition, loc: LOCS[id % 2]! });
        if (op.identify) {
          // The merchant types the ref of a unit of this line still out (15.5).
          const candidate = s.allocations.find(
            (a) => a.orderGid === o.gid && a.lineItemGid === lineGid(l.n) && a.status === 'fulfilled' && !a.returnExpected,
          );
          if (candidate) {
            next = {
              ...s,
              returnIdentifications: [...s.returnIdentifications, { returnLineItemGid: `gid://shopify/ReturnLineItem/${id}`, unitId: candidate.unitId, typedRef: 'typed' }],
            };
          }
        }
      }
      break;
    }
  }
  return { order: o, state: next };
}

function checkConsistency(s: SyncState, orders: SimOrder[]): void {
  // G1: one engagement per unit at most.
  const engaged = s.allocations.filter((a) => a.status === 'active' || a.status === 'fulfilled');
  expect(new Set(engaged.map((a) => a.unitId)).size).toBe(engaged.length);

  // Unit ↔ allocation rule (11.2).
  for (const u of s.units) {
    const active = s.allocations.filter((a) => a.unitId === u.id && a.status === 'active');
    const fulfilled = s.allocations.filter((a) => a.unitId === u.id && a.status === 'fulfilled');
    if (u.status === 'ALLOCATED') {
      expect(active).toHaveLength(1);
      expect(active[0]!.locationId).toBe(u.locationId);
    } else if (u.status === 'SHIPPED' || u.status === 'RETURN_PENDING') {
      expect(active).toHaveLength(0);
      expect(fulfilled.length).toBeLessThanOrEqual(1);
      if (u.status === 'RETURN_PENDING') expect(fulfilled[0]?.returnExpected).toBe(true);
    } else {
      expect(active.length + fulfilled.length).toBe(0);
    }
  }

  // Allocated never exceeds ordered: active ≤ open remaining at the FO location, engaged ≤ quantity.
  for (const o of orders) {
    for (const l of o.lines) {
      const ofLine = s.allocations.filter((a) => a.orderGid === o.gid && a.lineItemGid === lineGid(l.n));
      const active = ofLine.filter((a) => a.status === 'active');
      const open = o.cancelledAt === null ? l.remaining : 0;
      expect(active.length).toBeLessThanOrEqual(open);
      expect(active.every((a) => a.locationId === l.foLoc)).toBe(true);
      expect(ofLine.filter((a) => a.status === 'active' || a.status === 'fulfilled').length).toBeLessThanOrEqual(l.quantity);
      expect(ofLine.filter((a) => a.status === 'fulfilled').length).toBeLessThanOrEqual(fulfilledQty(l));
    }
  }
}

describe('order sync — properties', () => {
  it('idempotence, no unit allocated twice, allocated never exceeds ordered, over random event sequences', () => {
    fc.assert(
      fc.property(scenarioArb, ({ stock, orders: orderSpecs, ops }) => {
        let lineN = 0;
        const orders: SimOrder[] = orderSpecs.map((lines, i) => ({
          gid: `gid://shopify/Order/${9000 + i}`,
          lines: lines.map((l) => ({
            n: ++lineN,
            variant: l.variant,
            quantity: l.quantity,
            current: l.quantity,
            foLoc: LOCS[l.loc]!,
            foVersion: 0,
            remaining: l.quantity,
            fulfillments: [],
            returns: [],
          })),
          refunds: [],
          edits: [],
          cancelledAt: null,
          metafield: null,
        }));
        let s: SyncState = state({
          trackedItems: ITEMS,
          units: stock.map((u, i) => unit(`s${i}`, ITEMS[u.item]!.id, LOCS[u.loc]!, { receivedAt: T0 - 1000 + i })),
        });
        const seq = { n: 100, clock: T0 + 10_000 };
        const syncOrder = (o: SimOrder) => {
          const r = sync(snapshotOf(o), s, (seq.clock += 1000));
          o.metafield = r.snapshot.metafieldValue;
          s = r.state;
        };
        for (const o of orders) syncOrder(o);
        checkConsistency(s, orders);

        for (const op of ops) {
          seq.clock += 10;
          const r = applyOp(op, orders, s, seq);
          s = r.state;
          // A receipt triggers R2 on every order; an order event syncs that order.
          for (const o of r.order ? [r.order] : orders) syncOrder(o);
          checkConsistency(s, orders);
        }
      }),
      { numRuns: Number(process.env.FC_RUNS ?? 300) },
    );
  }, 600_000);
});
