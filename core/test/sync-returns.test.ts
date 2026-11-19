import { describe, expect, it } from 'vitest';
import { designateUnit } from '../src/designation.js';
import type { OrderSnapshot } from '../src/snapshot.js';
import type { StoredSetting } from '../src/settings.js';
import type { SyncState } from '../src/sync/plan.js';
import { returnLineSlots } from '../src/sync/planOrderSync.js';
import {
  LOC_A,
  LOC_B,
  T0,
  fo,
  fulfillment,
  item,
  line,
  openAnomalies,
  order,
  refund,
  ret,
  state,
  sync,
  unitStatus,
  units,
  type SyncResult,
} from './fixtures.js';

const I1 = item(1);
const RL = (n: number, l: number) => `gid://shopify/ReturnLineItem/${n}-${l}`;

/** Order of `qty` units of item 1 at A, allocated then fully shipped. */
function shippedOrder(qty: number): SyncResult {
  const open = order({ lineItems: [line(1, 1, qty)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: qty }])] });
  const first = sync(open, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, qty) }));
  const shipped: OrderSnapshot = {
    ...first.snapshot,
    fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 0, total: qty }], 'CLOSED')],
    fulfillments: [fulfillment(1, LOC_A, [{ line: 1, quantity: qty }])],
  };
  return sync(shipped, first.state, T0 + 20_000);
}

function identify(s: SyncState, returnLineItemGid: string, typedRef: string): SyncState {
  const candidates = s.units.map((u) => ({ unitId: u.id, identifiers: u.identifiers }));
  const match = designateUnit(typedRef, candidates);
  const unitId = match.ok ? match.unitId : null;
  return { ...s, returnIdentifications: [...s.returnIdentifications, { returnLineItemGid, unitId, typedRef }] };
}

describe('simple returns — F6, S-17 = yes (T-E2E-06 simple part, T-MVP-06)', () => {
  it('approval of a single-unit line: RETURN_PENDING at once; disposition waits for the typed ref (S-17)', () => {
    const shipped = shippedOrder(1);
    const approved = { ...shipped.snapshot, returns: [ret(1, 'OPEN', [{ line: 1, quantity: 1 }])] };
    const a = sync(approved, shipped.state, T0 + 30_000);
    expect(a.plan.unitTransitions).toEqual([expect.objectContaining({ unitId: 'a1', from: 'SHIPPED', to: 'RETURN_PENDING' })]);
    expect(a.state.allocations[0]).toMatchObject({ returnExpected: true, returnLineItemGid: RL(1, 1) });

    const disposed = { ...approved, returns: [ret(1, 'OPEN', [{ line: 1, quantity: 1 }], [{ line: 1, type: 'RESTOCKED', quantity: 1, locationId: LOC_A }])] };
    const waiting = sync(disposed, a.state, T0 + 40_000);
    expect(unitStatus(waiting.state, 'a1')).toBe('RETURN_PENDING');
    expect(openAnomalies(waiting.state, 'return_unidentified')).toHaveLength(1);
    expect(waiting.plan.explainedQuantities).toEqual([
      expect.objectContaining({ sourceType: 'return_unidentified', direction: 'deficit', inventoryState: 'available', quantity: 1 }),
    ]);

    // Ref typed by its last 4 characters (15.5).
    const done = sync(disposed, identify(waiting.state, RL(1, 1), 'n-a1'), T0 + 50_000);
    expect(unitStatus(done.state, 'a1')).toBe('AVAILABLE');
    expect(done.state.allocations[0]).toMatchObject({ status: 'returned', returnExpected: false });
    expect(openAnomalies(done.state)).toEqual([]);
    expect(done.plan.stockWrites).toEqual([]); // Restock written by Shopify (7.2).
    const status = (JSON.parse(done.plan.metafield.value as string) as { lines: { units: { status: string }[] }[] }).lines[0]?.units[0]?.status;
    expect(status).toBe('returned');
  });

  it('T-E2E-06 — each disposition type, applied after the typed ref, at the disposition location', () => {
    const cases = [
      { type: 'RESTOCKED', state: 'AVAILABLE', writes: [] },
      { type: 'PROCESSING_REQUIRED', state: 'QUALITY_CONTROL', writes: [{ kind: 'adjust', quantityName: 'quality_control', delta: 1, locationId: LOC_B }] },
      { type: 'NOT_RESTOCKED', state: 'SCRAPPED', writes: [] },
      { type: 'MISSING', state: 'LOST', writes: [] },
    ] as const;
    for (const c of cases) {
      const shipped = shippedOrder(1);
      const snap = {
        ...shipped.snapshot,
        returns: [ret(1, 'CLOSED', [{ line: 1, quantity: 1 }], [{ line: 1, type: c.type, quantity: 1, locationId: LOC_B }])],
      };
      const r = sync(snap, identify(shipped.state, RL(1, 1), 'SN-A1'), T0 + 30_000);
      const u = r.state.units.find((x) => x.id === 'a1');
      expect(u?.status, c.type).toBe(c.state);
      expect(u?.locationId).toBe(LOC_B);
      expect(r.plan.unitTransitions.map((t) => t.to)).toEqual(['RETURN_PENDING', c.state]);
      expect(r.plan.stockWrites).toEqual(c.writes.map((w) => expect.objectContaining(w)));
    }
  });

  it('PV-3 alternative: when Shopify adds a PROCESSING_REQUIRED return to available, the app moves it to quality_control', () => {
    const shipped = shippedOrder(1);
    const snap = { ...shipped.snapshot, returns: [ret(1, 'CLOSED', [{ line: 1, quantity: 1 }], [{ line: 1, type: 'PROCESSING_REQUIRED', quantity: 1, locationId: LOC_A }])] };
    const r = sync(snap, identify(shipped.state, RL(1, 1), 'SN-A1'), T0 + 30_000, [], { processingRequiredAddsAvailable: true });
    expect(r.plan.stockWrites).toEqual([expect.objectContaining({ kind: 'move', fromQuantityName: 'available', quantityName: 'quality_control' })]);
  });

  it('T-E2E-06 — line of several units: nothing moves until the unit is identified by its ref, then only that unit', () => {
    const shipped = shippedOrder(3);
    const snap = {
      ...shipped.snapshot,
      returns: [ret(1, 'OPEN', [{ line: 1, quantity: 1 }], [{ line: 1, type: 'RESTOCKED', quantity: 1, locationId: LOC_A }])],
    };
    const waiting = sync(snap, shipped.state, T0 + 30_000);
    expect(waiting.plan.unitTransitions).toEqual([]);
    expect(openAnomalies(waiting.state, 'return_unidentified')).toHaveLength(1);

    const done = sync(snap, identify(waiting.state, RL(1, 1), 'sn-a2'), T0 + 40_000);
    expect(['a1', 'a2', 'a3'].map((id) => unitStatus(done.state, id))).toEqual(['SHIPPED', 'AVAILABLE', 'SHIPPED']);
    expect(done.plan.unitTransitions.map((t) => `${t.unitId}:${t.from}>${t.to}`)).toEqual(['a2:SHIPPED>RETURN_PENDING', 'a2:RETURN_PENDING>AVAILABLE']);
    expect(openAnomalies(done.state)).toEqual([]);
  });

  it('T-MVP-06 — ref of another unit: return_unit_mismatch, no write, the expected unit stays RETURN_PENDING', () => {
    const shipped = shippedOrder(1);
    // A unit of the same item, sold elsewhere or unknown to this order.
    const withStranger = { ...shipped.state, units: [...shipped.state.units, ...units('z', I1.id, LOC_A, 1, 'SHIPPED')] };
    const snap = { ...shipped.snapshot, returns: [ret(1, 'OPEN', [{ line: 1, quantity: 1 }], [{ line: 1, type: 'RESTOCKED', quantity: 1, locationId: LOC_A }])] };
    const r = sync(snap, identify(withStranger, RL(1, 1), 'SN-Z1'), T0 + 30_000);
    expect(unitStatus(r.state, 'a1')).toBe('RETURN_PENDING');
    expect(unitStatus(r.state, 'z1')).toBe('SHIPPED');
    expect(r.plan.stockWrites).toEqual([]);
    expect(openAnomalies(r.state, 'return_unit_mismatch')).toEqual([expect.objectContaining({ subject: expect.objectContaining({ unitId: 'z1' }) })]);
    // Recette 2: the identification took place, return_unit_mismatch takes over (F6 1 bis); the restock stays explained.
    expect(openAnomalies(r.state, 'return_unidentified')).toEqual([]);
    expect(r.plan.explainedQuantities).toEqual([expect.objectContaining({ sourceType: 'return_unidentified', direction: 'deficit', quantity: 1 })]);
  });

  it('recette 2 — a mismatch closes the open return_unidentified; on a line of several units only the identified quantity leaves it', () => {
    const shipped = shippedOrder(3);
    const withStranger = { ...shipped.state, units: [...shipped.state.units, ...units('z', I1.id, LOC_A, 1, 'SHIPPED')] };
    const snap = { ...shipped.snapshot, returns: [ret(1, 'OPEN', [{ line: 1, quantity: 2 }], [{ line: 1, type: 'RESTOCKED', quantity: 2, locationId: LOC_A }])] };
    const waiting = sync(snap, withStranger, T0 + 30_000);
    expect(openAnomalies(waiting.state, 'return_unidentified')).toEqual([expect.objectContaining({ details: { quantity: 2 } })]);
    const one = sync(snap, identify(waiting.state, RL(1, 1), 'SN-Z1'), T0 + 40_000);
    expect(openAnomalies(one.state, 'return_unidentified')).toEqual([expect.objectContaining({ details: { quantity: 1 } })]);
    expect(openAnomalies(one.state, 'return_unit_mismatch')).toHaveLength(1);
    const two = sync(snap, identify(one.state, RL(1, 1), 'SN-A2'), T0 + 50_000);
    expect(unitStatus(two.state, 'a2')).toBe('AVAILABLE');
    expect(openAnomalies(two.state, 'return_unidentified')).toEqual([]);
    expect(openAnomalies(two.state, 'return_unit_mismatch')).toHaveLength(1);
  });

  it('an unknown ref also opens return_unit_mismatch', () => {
    const shipped = shippedOrder(1);
    const snap = { ...shipped.snapshot, returns: [ret(1, 'OPEN', [{ line: 1, quantity: 1 }])] };
    const r = sync(snap, identify(shipped.state, RL(1, 1), 'NOPE-0000'), T0 + 30_000);
    expect(openAnomalies(r.state, 'return_unit_mismatch')).toHaveLength(1);
  });

  describe('recette 2 — not restocked as Shopify reports it (no location, or no disposition at all)', () => {
    const run = (r: ReturnType<typeof ret>, typed = true) => {
      const shipped = shippedOrder(1);
      const approved = sync({ ...shipped.snapshot, returns: [ret(1, 'OPEN', [{ line: 1, quantity: 1 }])] }, shipped.state, T0 + 30_000);
      expect(unitStatus(approved.state, 'a1')).toBe('RETURN_PENDING');
      const s = typed ? identify(approved.state, RL(1, 1), 'SN-A1') : approved.state;
      return sync({ ...shipped.snapshot, returns: [r] }, s, T0 + 40_000);
    };

    it('NOT_RESTOCKED and MISSING dispositions without a location: scrapped / lost at the shipping location, no write', () => {
      for (const [type, to] of [['NOT_RESTOCKED', 'SCRAPPED'], ['MISSING', 'LOST']] as const) {
        const r = run(ret(1, 'OPEN', [{ line: 1, quantity: 1 }], [{ line: 1, type, quantity: 1, locationId: null }]));
        const u = r.state.units.find((x) => x.id === 'a1');
        expect(u?.status, type).toBe(to);
        expect(u?.locationId).toBe(LOC_A);
        expect(r.plan.stockWrites).toEqual([]);
        expect(r.plan.explainedQuantities).toEqual([]);
        expect(openAnomalies(r.state)).toEqual([]);
      }
    });

    it('processed by returnProcess without a disposition: not restocked (scrapped), even while the return is open', () => {
      const r = run(ret(1, 'OPEN', [{ line: 1, quantity: 1, processed: 1 }]));
      expect(unitStatus(r.state, 'a1')).toBe('SCRAPPED');
      expect(r.plan.unitTransitions).toEqual([expect.objectContaining({ to: 'SCRAPPED', data: { disposition: 'NOT_RESTOCKED', inferredFrom: 'processed' } })]);
      expect(r.plan.stockWrites).toEqual([]);
    });

    it('closed without any disposition: not restocked (scrapped), no write; replay is a no-op', () => {
      const r = run(ret(1, 'CLOSED', [{ line: 1, quantity: 1 }]));
      expect(unitStatus(r.state, 'a1')).toBe('SCRAPPED');
      expect(r.plan.unitTransitions).toEqual([expect.objectContaining({ data: { disposition: 'NOT_RESTOCKED', inferredFrom: 'closed' } })]);
      const replay = sync(r.snapshot, r.state, T0 + 50_000);
      expect(replay.plan.unitTransitions).toEqual([]);
    });

    it('unit not identified (S-17): return_unidentified opens, no explained quantity; the typed ref finishes it', () => {
      const r = run(ret(1, 'CLOSED', [{ line: 1, quantity: 1 }], [{ line: 1, type: 'NOT_RESTOCKED', quantity: 1, locationId: null }]), false);
      expect(unitStatus(r.state, 'a1')).toBe('RETURN_PENDING');
      expect(openAnomalies(r.state, 'return_unidentified')).toHaveLength(1);
      expect(r.plan.explainedQuantities).toEqual([]);
      const done = sync(r.snapshot, identify(r.state, RL(1, 1), 'SN-A1'), T0 + 60_000);
      expect(unitStatus(done.state, 'a1')).toBe('SCRAPPED');
      expect(openAnomalies(done.state)).toEqual([]);
    });

    it('restocked part and not-restocked rest of a processed line: each quantity is applied once', () => {
      const s = returnLineSlots(ret(1, 'CLOSED', [{ line: 1, quantity: 3, processed: 3 }], [{ line: 1, type: 'RESTOCKED', quantity: 1, locationId: LOC_A }]), {
        gid: RL(1, 1),
        lineItemGid: 'gid://shopify/LineItem/1',
        quantity: 3,
        processedQuantity: 3,
      });
      expect(s.map((x) => `${x.type}:${x.quantity}:${x.inferred ?? '-'}`)).toEqual(['RESTOCKED:1:-', 'NOT_RESTOCKED:2:processed']);
    });
  });

  it('return declined or cancelled: RETURN_PENDING → SHIPPED, return no longer expected', () => {
    const shipped = shippedOrder(1);
    const approved = { ...shipped.snapshot, returns: [ret(1, 'OPEN', [{ line: 1, quantity: 1 }])] };
    const a = sync(approved, shipped.state, T0 + 30_000);
    const declined = { ...approved, returns: [ret(1, 'DECLINED', [{ line: 1, quantity: 1 }])] };
    const d = sync(declined, a.state, T0 + 40_000);
    expect(d.plan.unitTransitions).toEqual([expect.objectContaining({ from: 'RETURN_PENDING', to: 'SHIPPED', event: 'return_cancelled' })]);
    expect(d.state.allocations[0]).toMatchObject({ returnExpected: false, returnLineItemGid: null, status: 'fulfilled' });
  });

  it('S-17 no: a single-unit return line applies its disposition without a typed ref', () => {
    const settings: StoredSetting[] = [{ scopeType: 'shop', scopeId: '', key: 'S-17', value: false }];
    const shipped = shippedOrder(1);
    const snap = { ...shipped.snapshot, returns: [ret(1, 'CLOSED', [{ line: 1, quantity: 1 }], [{ line: 1, type: 'RESTOCKED', quantity: 1, locationId: LOC_A }])] };
    const r = sync(snap, shipped.state, T0 + 30_000, settings);
    expect(unitStatus(r.state, 'a1')).toBe('AVAILABLE');
    expect(openAnomalies(r.state)).toEqual([]);
    // A line of several units still needs the ref (fixed rule of 6.6.3).
    const multi = shippedOrder(2);
    const snap2 = { ...multi.snapshot, returns: [ret(1, 'CLOSED', [{ line: 1, quantity: 1 }], [{ line: 1, type: 'RESTOCKED', quantity: 1, locationId: LOC_A }])] };
    expect(openAnomalies(sync(snap2, multi.state, T0 + 30_000, settings).state, 'return_unidentified')).toHaveLength(1);
  });

  it('refund with restock RETURN outside a Shopify return (EF-23): treated as a restocked return to identify', () => {
    const shipped = shippedOrder(2);
    const snap = { ...shipped.snapshot, refunds: [refund(7, [{ line: 1, quantity: 1, restockType: 'RETURN', locationId: LOC_A }])] };
    const waiting = sync(snap, shipped.state, T0 + 30_000);
    expect(openAnomalies(waiting.state, 'return_unidentified')).toHaveLength(1);
    const synthetic = 'gid://shopify/Refund/7#gid://shopify/LineItem/1';
    const done = sync(snap, identify(waiting.state, synthetic, 'SN-A1'), T0 + 40_000);
    expect(unitStatus(done.state, 'a1')).toBe('AVAILABLE');
    expect(unitStatus(done.state, 'a2')).toBe('SHIPPED');
    expect(openAnomalies(done.state)).toEqual([]);
  });

  it('a returned unit does not reopen shipped_without_unit for its line', () => {
    const shipped = shippedOrder(1);
    const snap = { ...shipped.snapshot, returns: [ret(1, 'CLOSED', [{ line: 1, quantity: 1 }], [{ line: 1, type: 'RESTOCKED', quantity: 1, locationId: LOC_A }])] };
    const r = sync(snap, identify(shipped.state, RL(1, 1), 'SN-A1'), T0 + 30_000);
    expect(openAnomalies(r.state, 'shipped_without_unit')).toEqual([]);
  });
});
