import { describe, expect, it } from 'vitest';
import { LOCATIONS, makeTrackedItem, makeUnit } from '@serialis/extensions-shared/testing';
import {
  countStates, filterUnits, pickLocations, recentUnits, summarizeLocations, totals, unitsAppHref,
} from '../src/logic';

describe('summarizeLocations', () => {
  it('counts units by state per location and computes the gap with Shopify on_hand', () => {
    const item = makeTrackedItem({
      stock: [
        { locationId: 'loc-a', shopifyOnHand: 7, registeredUnits: 4, availableUnits: 2 },
        { locationId: 'loc-b', shopifyOnHand: 1, registeredUnits: 3, availableUnits: 0 },
      ],
    });
    const units = [
      makeUnit('A1'), makeUnit('A2'), makeUnit('A3', { state: 'ALLOCATED' }), makeUnit('A4', { state: 'DAMAGED' }),
      makeUnit('B1', { locationId: 'loc-b', state: 'HELD' }),
      makeUnit('S1', { locationId: null, state: 'SHIPPED' }),
    ];
    const s = summarizeLocations(item, units, LOCATIONS);
    expect(s.map((x) => [x.name, x.shopifyOnHand, x.gap, x.total])).toEqual([
      ['Entrepôt', 7, 3, 4],
      ['Boutique', 1, -2, 1],
      [null, null, null, 1],
    ]);
    expect(s[0]!.counts).toEqual([
      { state: 'AVAILABLE', count: 2 }, { state: 'ALLOCATED', count: 1 }, { state: 'DAMAGED', count: 1 },
    ]);
  });

  it('lists a location with stock but no unit', () => {
    const s = summarizeLocations(makeTrackedItem(), [], LOCATIONS);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ name: 'Entrepôt', total: 0, gap: 0 });
  });
});

describe('filterUnits', () => {
  it('matches a ref fragment, ignoring case', () => {
    const units = [makeUnit('AB-001'), makeUnit('CD-002')];
    expect(filterUnits(units, 'b-0').map((u) => u.ref)).toEqual(['AB-001']);
    expect(filterUnits(units, '  ')).toBe(units);
  });
});

describe('compact view helpers', () => {
  const summary = (id: string, gap: number | null) => ({ locationId: id, name: id, shopifyOnHand: 0, registeredUnits: 0, gap, counts: [], total: 0 });

  it('pickLocations puts locations with a gap first and caps the list', () => {
    const r = pickLocations([summary('a', 0), summary('b', 2), summary('c', null), summary('d', -1), summary('e', 0)]);
    expect(r.shown.map((s) => s.locationId)).toEqual(['b', 'd', 'a']);
    expect(r.hidden).toBe(2);
    expect(pickLocations([summary('a', 0)]).hidden).toBe(0);
  });

  it('recentUnits keeps the most recently received units first', () => {
    const units = [
      makeUnit('OLD', { receivedAt: '2026-01-01T00:00:00Z' }),
      makeUnit('NEW', { receivedAt: '2026-05-01T00:00:00Z' }),
      makeUnit('NONE', { receivedAt: null, createdAt: '2026-04-01T00:00:00Z' }),
      makeUnit('MID', { receivedAt: '2026-03-01T00:00:00Z' }),
    ];
    expect(recentUnits(units).map((u) => u.ref)).toEqual(['NEW', 'NONE', 'MID']);
    expect(recentUnits(units, 0)).toEqual([]);
  });

  it('countStates aggregates every location in display order', () => {
    const units = [makeUnit('A', { state: 'ALLOCATED' }), makeUnit('B'), makeUnit('C', { locationId: 'loc-b' })];
    expect(countStates(units)).toEqual([{ state: 'AVAILABLE', count: 2 }, { state: 'ALLOCATED', count: 1 }]);
  });

  it('totals sums the registered refs and the gap over the stock locations', () => {
    const item = makeTrackedItem({ stock: [
      { locationId: 'loc-a', shopifyOnHand: 10, registeredUnits: 4, availableUnits: 4 },
      { locationId: 'loc-b', shopifyOnHand: 1, registeredUnits: 2, availableUnits: 2 },
    ] });
    expect(totals(item)).toEqual({ registered: 6, gap: 5 });
  });

  it('unitsAppHref links to the unit list of the app filtered on the variant', () => {
    expect(unitsAppHref('gid://shopify/ProductVariant/1001')).toBe('app:units?variant=gid%3A%2F%2Fshopify%2FProductVariant%2F1001');
  });
});
