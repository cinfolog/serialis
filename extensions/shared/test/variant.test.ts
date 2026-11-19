import { describe, expect, it } from 'vitest';
import type { CreateUnitsBatchResponse } from '@serialis/contract';
import { LOCATIONS, makeTrackedItem, makeUnit } from '../src/testing';
import {
  addLocationOptions, buildAddPlan, countByLocation, defaultKind, newFirst, gapAt, initialAddLocation, summarizeBatch, toBatchRequest, unitsAppHref,
} from '../src/variant';

describe('defaultKind', () => {
  it('proposes "already counted" when Shopify shows a gap or during initialization', () => {
    expect(defaultKind(3, false)).toBe('already_counted');
    expect(defaultKind(0, true)).toBe('already_counted');
    expect(defaultKind(0, false)).toBe('received');
    expect(defaultKind(null, false)).toBe('received');
  });
});

describe('buildAddPlan', () => {
  it('classifies lines and announces the stock effect of "received"', () => {
    const plan = buildAddPlan({ text: 'A1\nA2, a1 K9 !'.replace('!', 'x'.repeat(200)), knownRefs: ['k9'], kind: 'received', gap: 0 });
    expect(plan.readyRefs).toEqual(['A1', 'A2']);
    expect(plan.counts).toEqual({ ready: 2, duplicate: 1, known: 1, invalid: 1 });
    expect(plan.stockDelta).toBe(2);
    expect(plan.blocked).toBeNull();
  });

  it('writes no stock for "already counted" and blocks it when Shopify shows no gap (15.7)', () => {
    const plan = buildAddPlan({ text: 'A1', knownRefs: [], kind: 'already_counted', gap: 0 });
    expect(plan.stockDelta).toBe(0);
    expect(plan.blocked).toBe('no_gap');
  });

  it('warns, without blocking, when "already counted" exceeds the gap', () => {
    const plan = buildAddPlan({ text: 'A1 A2 A3', knownRefs: [], kind: 'already_counted', gap: 2 });
    expect(plan.exceedsGap).toBe(true);
    expect(plan.blocked).toBeNull();
  });

  it('blocks an empty plan and more than 1,000 refs', () => {
    expect(buildAddPlan({ text: '  ', knownRefs: [], kind: 'received', gap: 0 }).blocked).toBe('nothing');
    const many = Array.from({ length: 1001 }, (_, i) => `R${i}`).join('\n');
    expect(buildAddPlan({ text: many, knownRefs: [], kind: 'received', gap: 0 }).blocked).toBe('too_many');
  });

  it('builds a per_item batch request with only the ready refs', () => {
    const plan = buildAddPlan({ text: 'A1 A1 B2', knownRefs: [], kind: 'already_counted', gap: 5 });
    expect(toBatchRequest(plan, 'gid://shopify/ProductVariant/1', 'loc-a')).toEqual({
      variantGid: 'gid://shopify/ProductVariant/1', locationId: 'loc-a', refs: ['A1', 'B2'], alreadyCounted: true, mode: 'per_item',
    });
  });
});

describe('summarizeBatch', () => {
  it('maps rejected indexes back to the refs sent and keeps them for correction', () => {
    const plan = buildAddPlan({ text: 'A1 A1 B2 C3', knownRefs: [], kind: 'received', gap: 0 });
    const res: CreateUnitsBatchResponse = {
      created: [makeUnit('A1'), makeUnit('C3')],
      rejected: [{ index: 1, ref: '', code: 'identifier_conflict', detail: 'exists on another variant' }],
    };
    const out = summarizeBatch(plan, res);
    expect(out.created).toBe(2);
    expect(out.rejected).toEqual([{ ref: 'B2', code: 'identifier_conflict', detail: 'exists on another variant' }]);
    expect(out.remainingText).toBe('B2');
  });
});

describe('location of the added refs', () => {
  const item = makeTrackedItem({ stock: [
    { locationId: 'loc-a', shopifyOnHand: 2, registeredUnits: 2, availableUnits: 2 },
    { locationId: 'loc-b', shopifyOnHand: 3, registeredUnits: 1, availableUnits: 1 },
  ] });

  it('offers active locations and any location holding stock, even inactive or unlisted', () => {
    const locations = [...LOCATIONS, { id: 'loc-c', name: 'Fermé', active: false }];
    expect(addLocationOptions(item, locations).map((l) => l.id)).toEqual(['loc-a', 'loc-b']);
    const withOld = makeTrackedItem({ stock: [{ locationId: 'loc-x', shopifyOnHand: 1, registeredUnits: 0, availableUnits: 0 }] });
    expect(addLocationOptions(withOld, [LOCATIONS[0]!]).map((l) => l.id)).toEqual(['loc-a', 'loc-x']);
  });

  it('proposes the location with units to register, else the main location', () => {
    expect(initialAddLocation(item, LOCATIONS)).toBe('loc-b');
    expect(initialAddLocation(makeTrackedItem(), LOCATIONS)).toBe('loc-a');
    expect(initialAddLocation(makeTrackedItem({ stock: [] }), [])).toBe('');
  });

  it('recette 2 — the largest positive gap wins over list order; without a gap, the main (oldest active) location', () => {
    const shopLocations = [
      { id: 'gid://shopify/Location/90', name: 'My Custom Location', active: true },
      { id: 'gid://shopify/Location/12', name: 'Entrepôt', active: true },
      { id: 'gid://shopify/Location/5', name: 'Fermé', active: false },
    ];
    const stock = (id: string, onHand: number, registered: number) => ({ locationId: id, shopifyOnHand: onHand, registeredUnits: registered, availableUnits: registered });
    const gaps = makeTrackedItem({ stock: [stock('gid://shopify/Location/90', 2, 1), stock('gid://shopify/Location/12', 6, 1)] });
    expect(initialAddLocation(gaps, shopLocations)).toBe('gid://shopify/Location/12');
    const aligned = makeTrackedItem({ stock: [stock('gid://shopify/Location/90', 1, 1), stock('gid://shopify/Location/12', 1, 1)] });
    expect(initialAddLocation(aligned, shopLocations)).toBe('gid://shopify/Location/12');
    expect(initialAddLocation(makeTrackedItem({ stock: [] }), shopLocations)).toBe('gid://shopify/Location/12');
  });

  it('gapAt gives the gap of one location, null without stock data', () => {
    expect(gapAt(item, 'loc-b')).toBe(2);
    expect(gapAt(item, 'loc-z')).toBeNull();
  });

  it('unitsAppHref can open the add form of the Units screen', () => {
    expect(unitsAppHref('gid://shopify/ProductVariant/1001', { add: true })).toBe('app:units?variant=gid%3A%2F%2Fshopify%2FProductVariant%2F1001&add=1');
  });
});

describe('refs already registered (decision 3)', () => {
  it('countByLocation: here vs elsewhere (other locations or none)', () => {
    const units = [makeUnit('A'), makeUnit('B', { locationId: 'loc-b' }), makeUnit('C', { locationId: null })];
    expect(countByLocation(units, 'loc-a')).toEqual({ here: 1, elsewhere: 2 });
  });

  it('newFirst: added units first, without repeating them', () => {
    const a = makeUnit('A');
    const n = makeUnit('N');
    expect(newFirst([n], [a, n]).map((u) => u.ref)).toEqual(['N', 'A']);
  });

  it('buildAddPlan: refs refused by the server check are invalid, refs it knows are known', () => {
    const plan = buildAddPlan({ text: 'n1 X-9 BAD', knownRefs: ['x-9'], invalidRefs: ['bad'], kind: 'received', gap: null });
    expect(plan.lines.map((l) => l.status)).toEqual(['ready', 'known', 'invalid']);
    expect(plan.readyRefs).toEqual(['n1']);
  });
});
