import { describe, expect, it } from 'vitest';
import type { StoredSetting } from '../src/settings.js';
import { planOrderSync } from '../src/sync/planOrderSync.js';
import { isEmptyPlan, type SyncState } from '../src/sync/plan.js';
import type { Allocation } from '../src/types.js';
import { planToVerifyRestock } from '../src/stock.js';
import {
  LOC_A,
  LOC_B,
  ORDER,
  T0,
  activeUnitIds,
  fo,
  fulfillment,
  item,
  line,
  openAnomalies,
  order,
  refund,
  state,
  sync,
  unit,
  unitStatus,
  units,
} from './fixtures.js';

const I1 = item(1);
const I2 = item(2);
const shop = (key: StoredSetting['key'], value: unknown): StoredSetting => ({ scopeType: 'shop', scopeId: '', key, value });

function metafieldRefs(value: string | null, lineN: number): string[] {
  if (value === null) return [];
  const parsed = JSON.parse(value) as { lines: { line_item_id: string; units: { unit_id: string }[] }[] };
  return parsed.lines.find((l) => l.line_item_id === `gid://shopify/LineItem/${lineN}`)?.units.map((u) => u.unit_id) ?? [];
}

describe('order sync — allocation at order creation (F1, F15)', () => {
  it('T-E2E-01 — one unit ordered, enough stock: allocated, no hold, metafield written', () => {
    const snap = order({ lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    const { plan, state: s } = sync(snap, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 2) }));
    expect(plan.status).toBe('ok');
    expect(plan.allocationsToCreate).toHaveLength(1);
    expect(plan.allocationsToCreate[0]).toMatchObject({ unitId: 'a1', status: 'active', source: 'auto', locationId: LOC_A });
    expect(unitStatus(s, 'a1')).toBe('ALLOCATED');
    expect(plan.metafield.write).toBe(true);
    expect(metafieldRefs(plan.metafield.value, 1)).toEqual(['a1']);
    expect(plan.anomaliesToOpen).toEqual([]);
    expect(plan.stockWrites).toEqual([]); // AVAILABLE → ALLOCATED is written by Shopify (7.2).
  });

  it('T-MVP-02 — line of quantity 3: three distinct units from the FO location, metafield lists the 3, untracked line untouched', () => {
    const snap = order({
      lineItems: [line(1, 1, 3), line(2, 99, 1)],
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 3 }, { line: 2, remaining: 1 }])],
    });
    const st = state({ trackedItems: [I1], units: [...units('a', I1.id, LOC_A, 4), ...units('b', I1.id, LOC_B, 4)] });
    const { plan, state: s } = sync(snap, st);
    expect(activeUnitIds(s, 1)).toEqual(['a1', 'a2', 'a3']);
    expect(new Set(plan.allocationsToCreate.map((a) => a.unitId)).size).toBe(3);
    expect(plan.allocationsToCreate.every((a) => a.lineItemGid === 'gid://shopify/LineItem/1')).toBe(true);
    expect(metafieldRefs(plan.metafield.value, 1)).toEqual(['a1', 'a2', 'a3']);
    expect(metafieldRefs(plan.metafield.value, 2)).toEqual([]);
  });

  it('T-MVP-03 — unit replaced from the order block: metafield updated at the next sync, nothing else', () => {
    const snap = order({ lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    const first = sync(snap, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 3) }));
    const old = first.state.allocations[0] as Allocation;
    // Replacement done by the API (F4): old released, new allocated, in one transaction.
    const replaced: SyncState = {
      ...first.state,
      units: first.state.units.map((u) =>
        u.id === 'a1' ? { ...u, status: 'AVAILABLE' } : u.id === 'a3' ? { ...u, status: 'ALLOCATED' } : u,
      ),
      allocations: [
        { ...old, status: 'released', releasedAt: T0 + 20_000, releaseKind: 'manual' },
        { ...old, id: 'manual-1', unitId: 'a3', source: 'api', allocatedAt: T0 + 20_000 },
      ],
    };
    const { plan } = sync(first.snapshot, replaced, T0 + 30_000);
    expect(plan.unitTransitions).toEqual([]);
    expect(plan.allocationsToCreate).toEqual([]);
    expect(plan.metafield.write).toBe(true);
    expect(metafieldRefs(plan.metafield.value, 1)).toEqual(['a3']);
  });

  it('T-MVP-03 — lines shipped from two locations take units in each', () => {
    const snap = order({
      lineItems: [line(1, 1, 1), line(2, 1, 2)],
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }]), fo(2, LOC_B, [{ line: 2, remaining: 2 }])],
    });
    const { state: s } = sync(snap, state({ trackedItems: [I1], units: [...units('a', I1.id, LOC_A, 2), ...units('b', I1.id, LOC_B, 2)] }));
    expect(activeUnitIds(s, 1)).toEqual(['a1']);
    expect(activeUnitIds(s, 2)).toEqual(['b1', 'b2']);
  });

  it('T-MVP-03 — quantity reduced by an order edit with restock: the last allocated unit is released', () => {
    const snap = order({ lineItems: [line(1, 1, 3)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 3 }])] });
    const first = sync(snap, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 3) }));
    const edited = {
      ...first.snapshot,
      lineItems: [line(1, 1, 3, { currentQuantity: 2 })],
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 2, total: 2 }])],
      edits: [{ lineItemGid: 'gid://shopify/LineItem/1', quantity: 1, restock: true }],
    };
    const { plan, state: s } = sync(edited, first.state, T0 + 20_000);
    expect(plan.unitTransitions).toEqual([expect.objectContaining({ unitId: 'a3', from: 'ALLOCATED', to: 'AVAILABLE', event: 'released' })]);
    expect(activeUnitIds(s)).toEqual(['a1', 'a2']);
    expect(metafieldRefs(plan.metafield.value, 1)).toEqual(['a1', 'a2']);
  });

  it('T-MVP-04 — same result for admin, draft and marketplace orders; no unit: insufficient_units, then receipt allocates and resolves', () => {
    for (const channel of ['online_store', 'draft_order', 'marketplace', 'other'] as const) {
      const snap = order({ channel, lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
      const empty = sync(snap, state({ trackedItems: [I1] }));
      expect(empty.plan.status).toBe('short');
      expect(empty.plan.allocationsToCreate).toEqual([]);
      expect(openAnomalies(empty.state, 'insufficient_units')).toHaveLength(1);
      expect(openAnomalies(empty.state, 'insufficient_units')[0]?.severity).toBe('critical');
      expect(empty.plan.uncoveredLines).toEqual([expect.objectContaining({ quantity: 1, locationId: LOC_A, trackedItemId: I1.id })]);

      const received = { ...empty.state, units: units('a', I1.id, LOC_A, 1) };
      const after = sync(empty.snapshot, received, T0 + 60_000);
      expect(activeUnitIds(after.state)).toEqual(['a1']);
      expect(openAnomalies(after.state)).toEqual([]);
      expect(after.plan.status).toBe('ok');
    }
  });

  it('T-MVP-05 — burst of 50 orders on 10 units: exactly 10 served, no unit twice, the others insufficient_units', () => {
    let s = state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 10) });
    for (let i = 0; i < 50; i++) {
      const snap = order({
        orderGid: `gid://shopify/Order/${2000 + i}`,
        lineItems: [line(1, 1, 1)],
        fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])],
      });
      s = sync(snap, s, T0 + i).state;
    }
    const active = s.allocations.filter((a) => a.status === 'active');
    expect(active).toHaveLength(10);
    expect(new Set(active.map((a) => a.unitId)).size).toBe(10);
    expect(openAnomalies(s, 'insufficient_units')).toHaveLength(40);
  });

  it('T-MVP-07 — mixed catalogue: only the tracked line is allocated; an untracked order is ignored and untouched', () => {
    const mixed = order({
      lineItems: [line(1, 1, 1), line(2, 99, 2)],
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }, { line: 2, remaining: 2 }])],
    });
    const { plan } = sync(mixed, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 3) }));
    expect(plan.allocationsToCreate.map((a) => a.lineItemGid)).toEqual(['gid://shopify/LineItem/1']);

    const untracked = order({ lineItems: [line(2, 99, 2)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 2, remaining: 2 }])], metafieldValue: '{"x":1}' });
    const ignored = planOrderSync(untracked, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 3) }), [], T0);
    expect(ignored.status).toBe('ignored');
    expect(isEmptyPlan(ignored)).toBe(true);
  });

  it('untracked or inactive items are ignored', () => {
    const inactive = item(1, { active: false });
    const snap = order({ lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    const plan = planOrderSync(snap, state({ trackedItems: [inactive], units: units('a', inactive.id, LOC_A, 1) }), [], T0);
    expect(plan.status).toBe('ignored');
    expect(isEmptyPlan(plan)).toBe(true);
  });

  it('T-MVP-08 — three ordered, two in stock: two allocated, the line waits, receipt allocates and resolves (D-03)', () => {
    const snap = order({ lineItems: [line(1, 1, 3)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 3 }])] });
    const first = sync(snap, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 2) }));
    expect(activeUnitIds(first.state)).toEqual(['a1', 'a2']);
    const waiting = openAnomalies(first.state).filter((a) => a.type === 'insufficient_units' || a.type === 'awaiting_unit');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.details).toMatchObject({ quantity: 1 });
    expect(first.plan.uncoveredLines).toEqual([expect.objectContaining({ quantity: 1 })]);

    const received = { ...first.state, units: [...first.state.units, unit('a9', I1.id, LOC_A)] };
    const after = sync(first.snapshot, received, T0 + 60_000);
    expect(activeUnitIds(after.state)).toEqual(['a1', 'a2', 'a9']);
    expect(openAnomalies(after.state)).toEqual([]);
  });

  it('T-MVP-08 — line shipped without unit: shipped_without_unit, never an automatic pick; late designation resolves it', () => {
    const snap = order({
      lineItems: [line(1, 1, 1)],
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 0, total: 1 }], 'CLOSED')],
      fulfillments: [fulfillment(1, LOC_A, [{ line: 1, quantity: 1 }])],
    });
    const first = sync(snap, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 2) }));
    expect(first.plan.allocationsToCreate).toEqual([]);
    expect(first.plan.unitTransitions).toEqual([]);
    const anomaly = openAnomalies(first.state, 'shipped_without_unit');
    expect(anomaly).toHaveLength(1);
    expect(anomaly[0]?.severity).toBe('critical');
    expect(first.plan.explainedQuantities).toEqual([
      expect.objectContaining({ sourceType: 'sale_without_unit', direction: 'surplus', quantity: 1, locationId: LOC_A }),
    ]);

    // Late designation (AVAILABLE → SHIPPED, source late), done by the API after a typed ref.
    const late: SyncState = {
      ...first.state,
      units: first.state.units.map((u) => (u.id === 'a2' ? { ...u, status: 'SHIPPED' } : u)),
      allocations: [
        {
          id: 'late-1',
          unitId: 'a2',
          variantGid: I1.variantGid,
          orderGid: ORDER,
          lineItemGid: 'gid://shopify/LineItem/1',
          fulfillmentOrderGid: 'gid://shopify/FulfillmentOrder/1',
          fulfillmentOrderLineItemGid: 'gid://shopify/FulfillmentOrderLineItem/1-1',
          locationId: LOC_A,
          status: 'fulfilled',
          source: 'late',
          returnExpected: false,
          toConfirm: false,
          allocationVersion: 1,
          allocatedAt: T0 + 30_000,
          fulfilledAt: T0 + 30_000,
          releasedAt: null,
          returnedAt: null,
          releaseKind: null,
          returnLineItemGid: null,
        },
      ],
    };
    const after = sync(first.snapshot, late, T0 + 40_000);
    expect(openAnomalies(after.state)).toEqual([]);
    expect(after.plan.anomaliesToResolve).toEqual([anomaly[0]?.id]);
    expect(metafieldRefs(after.plan.metafield.value, 1)).toEqual(['a2']);
  });

  it('T-MVP-08 — POS sale of a tracked item arriving fulfilled: pos_sold_without_unit (warning), no allocation (F15 a)', () => {
    const snap = order({
      channel: 'pos',
      retailLocationId: LOC_A,
      lineItems: [line(1, 1, 2)],
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 0, total: 2 }], 'CLOSED')],
      fulfillments: [fulfillment(1, LOC_A, [{ line: 1, quantity: 2 }])],
    });
    const { plan, state: s } = sync(snap, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 5) }));
    expect(plan.allocationsToCreate).toEqual([]);
    expect(plan.unitTransitions).toEqual([]);
    const pos = openAnomalies(s, 'pos_sold_without_unit');
    expect(pos).toHaveLength(1);
    expect(pos[0]).toMatchObject({ severity: 'warning', details: { quantity: 2 } });
    expect(openAnomalies(s, 'shipped_without_unit')).toEqual([]);
  });

  it('POS order with an open fulfillment order (ship later) is allocated like any order', () => {
    const snap = order({ channel: 'pos', lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    const { state: s } = sync(snap, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 1) }));
    expect(activeUnitIds(s)).toEqual(['a1']);
  });

  it('a POS unit property is never honoured in the MVP: invalid_serial_property once, line allocated by F1', () => {
    const snap = order({
      lineItems: [line(1, 1, 1, { serialisUnitsProperty: '["tok"]' })],
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])],
    });
    const first = sync(snap, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 1) }));
    expect(activeUnitIds(first.state)).toEqual(['a1']);
    const inv = openAnomalies(first.state, 'invalid_serial_property');
    expect(inv).toHaveLength(1);
    // Resolved by a person: never re-opened by later syncs.
    const resolved = { ...first.state, anomalies: first.state.anomalies.map((a) => ({ ...a, status: 'resolved' as const })) };
    const again = planOrderSync(first.snapshot, resolved, [], T0 + 99_000);
    expect(isEmptyPlan(again)).toBe(true);
  });
});

describe('order sync — unit choice (S-05), locks and locations', () => {
  it('FIFO by received date by default, among AVAILABLE units of the variant at the FO location only', () => {
    const us = [
      unit('x-late', I1.id, LOC_A, { receivedAt: T0 - 10 }),
      unit('x-early', I1.id, LOC_A, { receivedAt: T0 - 1000 }),
      unit('x-other-loc', I1.id, LOC_B, { receivedAt: T0 - 5000 }),
      unit('x-other-item', I2.id, LOC_A, { receivedAt: T0 - 5000 }),
      unit('x-qc', I1.id, LOC_A, { receivedAt: T0 - 5000, status: 'QUALITY_CONTROL' }),
    ];
    const snap = order({ lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    expect(activeUnitIds(sync(snap, state({ trackedItems: [I1, I2], units: us })).state)).toEqual(['x-early']);
  });

  it('S-05 fefo: the earliest warranty or expiry end is allocated first', () => {
    const us = [
      unit('f1', I1.id, LOC_A, { receivedAt: T0 - 1000, warrantyEndsAt: T0 + 9000 }),
      unit('f2', I1.id, LOC_A, { receivedAt: T0 - 10, expiresAt: T0 + 5000 }),
      unit('f3', I1.id, LOC_A, { receivedAt: T0 - 5000 }),
    ];
    const snap = order({ lineItems: [line(1, 1, 2)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 2 }])] });
    const settings = [{ scopeType: 'tracked_item' as const, scopeId: I1.id, key: 'S-05' as const, value: 'fefo' }];
    expect(activeUnitIds(sync(snap, state({ trackedItems: [I1], units: us }), T0 + 10_000, settings).state)).toEqual(['f1', 'f2']);
  });

  it('S-05 manual: no automatic allocation, awaiting_unit opened', () => {
    const snap = order({ lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    const { plan, state: s } = sync(snap, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 2) }), T0 + 10_000, [shop('S-05', 'manual')]);
    expect(plan.allocationsToCreate).toEqual([]);
    expect(openAnomalies(s, 'awaiting_unit')).toHaveLength(1);
    expect(openAnomalies(s, 'insufficient_units')).toEqual([]);
  });

  it('units locked by a POS or a pick are skipped; an expired lock is ignored', () => {
    const snap = order({ lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    const us = units('a', I1.id, LOC_A, 2);
    const locked = state({ trackedItems: [I1], units: us, locks: [{ unitId: 'a1', kind: 'pos', owner: 'register-1', expiresAt: T0 + 900_000 }] });
    expect(activeUnitIds(sync(snap, locked).state)).toEqual(['a2']);
    const expired = state({ trackedItems: [I1], units: us, locks: [{ unitId: 'a1', kind: 'pos', owner: 'register-1', expiresAt: T0 }] });
    expect(activeUnitIds(sync(snap, expired).state)).toEqual(['a1']);
  });

  it('a unit locked while it is the only one: awaiting_unit, not insufficient_units', () => {
    const snap = order({ lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    const s = state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 1), locks: [{ unitId: 'a1', kind: 'pick', owner: 'u', expiresAt: T0 + 900_000 }] });
    expect(openAnomalies(sync(snap, s).state, 'awaiting_unit')).toHaveLength(1);
  });

  it('units packed in a native transfer shipment are never allocated', () => {
    const snap = order({ lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    const us = [unit('p1', I1.id, LOC_A, { packedForShipment: true, receivedAt: 1 }), unit('p2', I1.id, LOC_A)];
    expect(activeUnitIds(sync(snap, state({ trackedItems: [I1], units: us })).state)).toEqual(['p2']);
  });

  it('a unit engaged in another order is never allocated again (G1)', () => {
    const a = order({ orderGid: 'gid://shopify/Order/1', lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    const b = order({ orderGid: 'gid://shopify/Order/2', lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    const s1 = sync(a, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 1) })).state;
    const s2 = sync(b, s1, T0 + 20_000).state;
    expect(s2.allocations.filter((x) => x.status === 'active')).toHaveLength(1);
    expect(openAnomalies(s2, 'insufficient_units')).toHaveLength(1);
  });

  it('emergency stop (EF-33): no automatic allocation, awaiting_unit', () => {
    const snap = order({ lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    const { plan, state: s } = sync(snap, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 1), automationPaused: true }));
    expect(plan.allocationsToCreate).toEqual([]);
    expect(openAnomalies(s, 'awaiting_unit')).toHaveLength(1);
  });

  it('scheduled fulfillment orders are not allocated until due (F13)', () => {
    const snap = order({ lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }], 'SCHEDULED')] });
    const { plan } = sync(snap, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 1) }));
    expect(plan.allocationsToCreate).toEqual([]);
    expect(plan.anomaliesToOpen).toEqual([]);
    const due = { ...snap, fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }], 'OPEN')] };
    expect(sync(due, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 1) })).plan.allocationsToCreate).toHaveLength(1);
  });

  it('fulfillment orders on hold by another app are still covered', () => {
    const snap = order({ lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }], 'ON_HOLD')] });
    expect(sync(snap, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 1) })).plan.allocationsToCreate).toHaveLength(1);
  });
});

describe('order sync — edits and cancellations (F3, F5)', () => {
  const three = order({ lineItems: [line(1, 1, 3)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 3 }])] });
  const allocatedThree = () => sync(three, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 4) }));

  it('T-E2E-03 — edit removing an allocated line (restocked) and adding another variant', () => {
    const snap = order({ lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    const first = sync(snap, state({ trackedItems: [I1, I2], units: [...units('a', I1.id, LOC_A, 2), ...units('c', I2.id, LOC_A, 2)] }));
    const edited = {
      ...first.snapshot,
      lineItems: [line(1, 1, 1, { currentQuantity: 0 }), line(3, 2, 1)],
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 0, total: 0 }, { line: 3, remaining: 1 }])],
      edits: [{ lineItemGid: 'gid://shopify/LineItem/1', quantity: 1, restock: true }],
    };
    const { plan, state: s } = sync(edited, first.state, T0 + 20_000);
    expect(unitStatus(s, 'a1')).toBe('AVAILABLE');
    expect(activeUnitIds(s)).toEqual(['c1']);
    expect(plan.unitTransitions.map((t) => `${t.unitId}:${t.from}>${t.to}`)).toEqual(['a1:ALLOCATED>AVAILABLE', 'c1:AVAILABLE>ALLOCATED']);
    expect(metafieldRefs(plan.metafield.value, 1)).toEqual([]);
    expect(metafieldRefs(plan.metafield.value, 3)).toEqual(['c1']);
  });

  it('T-E2E-04 — total cancellation with restock (CANCEL): units back to AVAILABLE, written by Shopify', () => {
    const first = allocatedThree();
    const cancelled = {
      ...first.snapshot,
      cancelledAt: T0 + 5000,
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 0, total: 3 }], 'CLOSED')],
      refunds: [refund(1, [{ line: 1, quantity: 3, restockType: 'CANCEL', locationId: LOC_A }])],
    };
    const { plan, state: s } = sync(cancelled, first.state, T0 + 20_000);
    expect(['a1', 'a2', 'a3'].map((id) => unitStatus(s, id))).toEqual(['AVAILABLE', 'AVAILABLE', 'AVAILABLE']);
    expect(plan.stockWrites).toEqual([]);
    expect(openAnomalies(s)).toEqual([]);
    expect(plan.metafield).toEqual({ value: null, write: true });
  });

  it('T-E2E-04 — total cancellation without restock (NO_RESTOCK): units TO_VERIFY with unit_to_verify', () => {
    const first = allocatedThree();
    const cancelled = {
      ...first.snapshot,
      cancelledAt: T0 + 5000,
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 0, total: 3 }], 'CLOSED')],
      refunds: [refund(1, [{ line: 1, quantity: 3, restockType: 'NO_RESTOCK' }])],
    };
    const { plan, state: s } = sync(cancelled, first.state, T0 + 20_000);
    expect(['a1', 'a2', 'a3'].map((id) => unitStatus(s, id))).toEqual(['TO_VERIFY', 'TO_VERIFY', 'TO_VERIFY']);
    expect(openAnomalies(s, 'unit_to_verify')).toHaveLength(3);
    expect(plan.stockWrites).toEqual([]);
  });

  it('T-E2E-04 — cancelled line without any refund line (unpaid order): restock unknown, TO_VERIFY (F5)', () => {
    const first = allocatedThree();
    const cancelled = { ...first.snapshot, cancelledAt: T0 + 5000, fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 0, total: 3 }], 'CLOSED')] };
    const { state: s } = sync(cancelled, first.state, T0 + 20_000);
    expect(unitStatus(s, 'a1')).toBe('TO_VERIFY');
  });

  it('T-E2E-04b — refund of one unit on a line of three: the last allocated is released, the two others stay', () => {
    const first = allocatedThree();
    const partial = {
      ...first.snapshot,
      lineItems: [line(1, 1, 3, { currentQuantity: 2 })],
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 2, total: 2 }])],
      refunds: [refund(1, [{ line: 1, quantity: 1, restockType: 'CANCEL', locationId: LOC_A }])],
    };
    const { plan, state: s } = sync(partial, first.state, T0 + 20_000);
    expect(plan.unitTransitions).toEqual([expect.objectContaining({ unitId: 'a3', to: 'AVAILABLE' })]);
    expect(activeUnitIds(s)).toEqual(['a1', 'a2']);
    // A second refund, without restock this time, does not reuse the first restock.
    const second = {
      ...partial,
      lineItems: [line(1, 1, 3, { currentQuantity: 1 })],
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1, total: 1 }])],
      refunds: [...partial.refunds, refund(2, [{ line: 1, quantity: 1, restockType: 'NO_RESTOCK' }])],
    };
    const after = sync(second, s, T0 + 30_000);
    expect(after.plan.unitTransitions).toEqual([expect.objectContaining({ unitId: 'a2', to: 'TO_VERIFY' })]);
  });

  it('S-08 first: a quantity reduction releases the first allocated unit', () => {
    const settings = [shop('S-08', 'first')];
    const first = sync(three, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 3) }), T0 + 10_000, settings);
    const partial = {
      ...first.snapshot,
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 2, total: 2 }])],
      refunds: [refund(1, [{ line: 1, quantity: 1, restockType: 'CANCEL', locationId: LOC_A }])],
    };
    const { state: s } = sync(partial, first.state, T0 + 20_000, settings);
    expect(activeUnitIds(s)).toEqual(['a2', 'a3']);
  });

  it('T-E2E-37 — edit removing an allocated line without restock: TO_VERIFY; "put back in stock" restocks once in total', () => {
    const snap = order({ lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    const first = sync(snap, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 2) }));
    const edited = {
      ...first.snapshot,
      lineItems: [line(1, 1, 1, { currentQuantity: 0 })],
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 0, total: 0 }], 'CLOSED')],
      edits: [{ lineItemGid: 'gid://shopify/LineItem/1', quantity: 1, restock: false }],
    };
    const { state: s } = sync(edited, first.state, T0 + 20_000);
    const toVerify = s.units.find((u) => u.id === 'a1');
    expect(toVerify?.status).toBe('TO_VERIFY');
    expect(openAnomalies(s, 'unit_to_verify')).toHaveLength(1);

    // Shopify did restock in fact (on_hand 2 for 1 counted unit): AVAILABLE without any write.
    const level = { trackedItemId: I1.id, locationId: LOC_A, onHand: 2, available: 2, committed: 0, reserved: 0, qualityControl: 0, damaged: 0 };
    const silent = planToVerifyRestock(toVerify!, I1, level, s.units, []);
    expect(silent).toMatchObject({ to: 'AVAILABLE', write: null });
    // Shopify did not restock (on_hand 1): the app adds 1 to available.
    const written = planToVerifyRestock(toVerify!, I1, { ...level, onHand: 1, available: 1 }, s.units, []);
    expect(written?.write).toMatchObject({ quantityName: 'available', delta: 1, locationId: LOC_A });
    // Once resolved, the unit is no longer TO_VERIFY: no second restock is possible.
    expect(planToVerifyRestock({ ...toVerify!, status: 'AVAILABLE' }, I1, level, s.units, [])).toBeNull();
  });

  it('S-11 process: test orders are allocated like the others', () => {
    const snap = order({ test: true, lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    const base = state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 1) });
    const ignored = sync(snap, base);
    expect(ignored.plan.status).toBe('ignored');
    expect(ignored.plan.allocationsToCreate).toEqual([]);
    const processed = sync(snap, base, T0 + 10_000, [shop('S-11', 'process')]);
    expect(activeUnitIds(processed.state)).toEqual(['a1']);
    // Back to "ignore": allocations of open test orders are released (simulation of S-11).
    const back = sync(processed.snapshot, processed.state, T0 + 20_000);
    expect(back.plan.status).toBe('ignored');
    expect(unitStatus(back.state, 'a1')).toBe('AVAILABLE');
  });
});

describe('order sync — shipments (F4)', () => {
  const three = order({ lineItems: [line(1, 1, 3)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 3 }])] });

  it('T-MVP-10 — 2 shipped out of 3 allocated: shipped_unit_to_confirm, no stock write; full shipment resolves it', () => {
    const first = sync(three, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 3) }));
    const partial = {
      ...first.snapshot,
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1, total: 3 }], 'IN_PROGRESS')],
      fulfillments: [fulfillment(1, LOC_A, [{ line: 1, quantity: 2 }])],
    };
    const shipped = sync(partial, first.state, T0 + 20_000);
    expect(shipped.plan.stockWrites).toEqual([]);
    expect(['a1', 'a2', 'a3'].map((id) => unitStatus(shipped.state, id))).toEqual(['SHIPPED', 'SHIPPED', 'ALLOCATED']);
    expect(shipped.state.allocations.filter((a) => a.toConfirm).map((a) => a.unitId).sort()).toEqual(['a1', 'a2']);
    const confirm = openAnomalies(shipped.state, 'shipped_unit_to_confirm');
    expect(confirm).toHaveLength(1);
    expect(confirm[0]?.details).toMatchObject({ quantity: 2, unitIds: ['a1', 'a2'] });

    const full = {
      ...partial,
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 0, total: 3 }], 'CLOSED')],
      fulfillments: [...partial.fulfillments, fulfillment(2, LOC_A, [{ line: 1, quantity: 1 }])],
    };
    const done = sync(full, shipped.state, T0 + 30_000);
    expect(unitStatus(done.state, 'a3')).toBe('SHIPPED');
    expect(done.state.allocations.some((a) => a.toConfirm)).toBe(false);
    expect(openAnomalies(done.state)).toEqual([]);
  });

  it('T-E2E-05 — partial then total shipment: units SHIPPED, allocations fulfilled, metafield statuses', () => {
    const first = sync(three, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 3) }));
    const partial = {
      ...first.snapshot,
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 2, total: 3 }])],
      fulfillments: [fulfillment(1, LOC_A, [{ line: 1, quantity: 1 }])],
    };
    const p = sync(partial, first.state, T0 + 20_000);
    expect(p.plan.unitTransitions).toEqual([expect.objectContaining({ unitId: 'a1', from: 'ALLOCATED', to: 'SHIPPED', event: 'shipped' })]);
    const total = {
      ...partial,
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 0, total: 3 }], 'CLOSED')],
      fulfillments: [...partial.fulfillments, fulfillment(2, LOC_A, [{ line: 1, quantity: 2 }])],
    };
    const t = sync(total, p.state, T0 + 30_000);
    expect(t.state.allocations.every((a) => a.status === 'fulfilled' && a.fulfilledAt !== null)).toBe(true);
    const statuses = (JSON.parse(t.plan.metafield.value as string) as { lines: { units: { status: string }[] }[] }).lines[0]?.units.map((u) => u.status);
    expect(statuses).toEqual(['shipped', 'shipped', 'shipped']);
    expect(openAnomalies(t.state)).toEqual([]);
  });

  it('shipment cancelled: SHIPPED → ALLOCATED on the same allocation (guarded transition)', () => {
    const one = order({ lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    const first = sync(one, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 1) }));
    const shippedSnap = {
      ...first.snapshot,
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 0, total: 1 }], 'CLOSED')],
      fulfillments: [fulfillment(1, LOC_A, [{ line: 1, quantity: 1 }])],
    };
    const shipped = sync(shippedSnap, first.state, T0 + 20_000);
    const allocationId = shipped.state.allocations[0]?.id;
    const cancelledSnap = {
      ...shippedSnap,
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1, total: 1 }])],
      fulfillments: [fulfillment(1, LOC_A, [{ line: 1, quantity: 1 }], { status: 'CANCELLED' })],
    };
    const back = sync(cancelledSnap, shipped.state, T0 + 30_000);
    expect(back.plan.unitTransitions).toEqual([
      expect.objectContaining({ unitId: 'a1', from: 'SHIPPED', to: 'ALLOCATED', event: 'shipment_cancelled', guarded: true, allocationId }),
    ]);
    expect(back.plan.allocationsToCreate).toEqual([]);
    expect(back.state.allocations).toEqual([expect.objectContaining({ id: allocationId, status: 'active', fulfilledAt: null })]);
  });

  it('partial shipment of a line whose remaining quantity has no unit asks no confirmation', () => {
    const first = sync(three, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 2) }));
    const partial = {
      ...first.snapshot,
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1, total: 3 }])],
      fulfillments: [fulfillment(1, LOC_A, [{ line: 1, quantity: 2 }])],
    };
    const s = sync(partial, first.state, T0 + 20_000).state;
    expect(openAnomalies(s, 'shipped_unit_to_confirm')).toEqual([]);
    expect(s.allocations.some((a) => a.toConfirm)).toBe(false);
  });

  it('shipments made before the activation of the item are never covered (EF-01)', () => {
    const snap = order({
      lineItems: [line(1, 1, 1)],
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 0, total: 1 }], 'CLOSED')],
      fulfillments: [fulfillment(1, LOC_A, [{ line: 1, quantity: 1 }], { createdAt: I1.activatedAt - 1 })],
    });
    const { plan } = sync(snap, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 1) }));
    expect(plan.anomaliesToOpen).toEqual([]);
  });

  it('preexisting line (S-24 fixed): neither allocated nor waiting; shipped → preexisting_sale_to_designate', () => {
    const open = order({ lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    const base = state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 1), preexistingLineItemGids: ['gid://shopify/LineItem/1'] });
    const first = sync(open, base);
    expect(first.plan.allocationsToCreate).toEqual([]);
    expect(first.plan.uncoveredLines).toEqual([]);
    expect(first.plan.anomaliesToOpen).toEqual([]);
    const shippedSnap = {
      ...open,
      fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 0, total: 1 }], 'CLOSED')],
      fulfillments: [fulfillment(1, LOC_A, [{ line: 1, quantity: 1 }])],
    };
    const shipped = sync(shippedSnap, first.state, T0 + 20_000);
    expect(openAnomalies(shipped.state, 'preexisting_sale_to_designate')).toHaveLength(1);
    expect(shipped.plan.explainedQuantities).toEqual([expect.objectContaining({ sourceType: 'preexisting_sale', quantity: 1 })]);
  });
});

describe('order sync — fulfillment order split and move (F13, EF-16)', () => {
  it('T-E2E-19 — split keeps every allocation; moving a part to another location recalculates only that part', () => {
    const snap = order({ lineItems: [line(1, 1, 4)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 4 }])] });
    const first = sync(snap, state({ trackedItems: [I1], units: [...units('a', I1.id, LOC_A, 4), ...units('b', I1.id, LOC_B, 4)] }));
    expect(activeUnitIds(first.state)).toEqual(['a1', 'a2', 'a3', 'a4']);

    const split = { ...first.snapshot, fulfillmentOrders: [fo(2, LOC_A, [{ line: 1, remaining: 2 }]), fo(3, LOC_A, [{ line: 1, remaining: 2 }])] };
    const s1 = sync(split, first.state, T0 + 20_000);
    expect(s1.plan.unitTransitions).toEqual([]);
    expect(s1.plan.metafield.write).toBe(false);
    expect(new Set(s1.state.allocations.map((a) => a.fulfillmentOrderGid))).toEqual(
      new Set(['gid://shopify/FulfillmentOrder/2', 'gid://shopify/FulfillmentOrder/3']),
    );

    const moved = { ...split, fulfillmentOrders: [fo(2, LOC_A, [{ line: 1, remaining: 2 }]), fo(4, LOC_B, [{ line: 1, remaining: 2 }])] };
    const s2 = sync(moved, s1.state, T0 + 30_000);
    const released = s2.plan.unitTransitions.filter((t) => t.event === 'released');
    expect(released).toHaveLength(2);
    expect(released.every((t) => t.data.releaseKind === 'relocated' && t.to === 'AVAILABLE')).toBe(true);
    expect(activeUnitIds(s2.state)).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(s2.state.allocations.filter((a) => a.status === 'active' && a.locationId === LOC_B).every((a) => a.fulfillmentOrderGid === 'gid://shopify/FulfillmentOrder/4')).toBe(true);
    expect(s2.plan.stockWrites).toEqual([]);
  });
});

describe('order sync — metafield (EF-18, 13.4)', () => {
  it('T-IDEM-02 — a metafield changed by another tool is restored once; the restored value is not rewritten', () => {
    const snap = order({ lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    const first = sync(snap, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 1) }));
    const tampered = { ...first.snapshot, metafieldValue: '{"version":1,"lines":[]}' };
    const restored = sync(tampered, first.state, T0 + 20_000);
    expect(restored.plan.metafield.write).toBe(true);
    expect(restored.plan.metafield.value).toBe(first.snapshot.metafieldValue);
  });

  it('S-38 no: the metafield is removed from the order', () => {
    const snap = order({ lineItems: [line(1, 1, 1)], fulfillmentOrders: [fo(1, LOC_A, [{ line: 1, remaining: 1 }])] });
    const first = sync(snap, state({ trackedItems: [I1], units: units('a', I1.id, LOC_A, 1) }));
    expect(first.snapshot.metafieldValue).not.toBeNull();
    const off = sync(first.snapshot, first.state, T0 + 20_000, [shop('S-38', false)]);
    expect(off.plan.metafield).toEqual({ value: null, write: true });
    expect(off.plan.unitTransitions).toEqual([]);
  });
});
