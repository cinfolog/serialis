import { describe, expect, it } from 'vitest';
import type { CreateUnitsBatchResponse } from '@serialis/contract';
import { LOCATIONS, makeTrackedItem, makeUnit } from '@serialis/extensions-shared/testing';
import { buildAddPlan, defaultKind, filterUnits, summarizeBatch, summarizeLocations, toBatchRequest } from '../src/logic';

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
