import { describe, expect, it } from 'vitest';
import { checkAllocationConsistency, checkInvariants, type InvariantInput } from '../src/invariants.js';
import { initializationShouldEnd, planAutomaticToVerifyResolution, usableDeficit, usableExcess } from '../src/stock.js';
import type { ExplainedQuantity, InventoryLevel } from '../src/types.js';
import { LOC_A, T0, item, unit, units } from './fixtures.js';

const I1 = item(1);
const level = (o: Partial<InventoryLevel> = {}): InventoryLevel => ({
  trackedItemId: I1.id,
  locationId: LOC_A,
  onHand: 3,
  available: 3,
  committed: 0,
  reserved: 0,
  qualityControl: 0,
  damaged: 0,
  ...o,
});
const input = (o: Partial<InvariantInput>): InvariantInput => ({ levels: [level()], units: units('a', I1.id, LOC_A, 3), uncovered: [], explained: [], ...o });
const explained = (o: Partial<ExplainedQuantity>): ExplainedQuantity => ({
  sourceType: 'sale_without_unit',
  sourceRef: 'x',
  trackedItemId: I1.id,
  locationId: LOC_A,
  inventoryState: 'available',
  direction: 'surplus',
  quantity: 1,
  status: 'open',
  ...o,
});

describe('stock invariants I1 to I6 — spec 8', () => {
  it('a consistent level has no violation', () => {
    expect(checkInvariants(input({}))).toEqual([]);
  });

  it('T-MVP-09 — manual adjustment in Shopify: I1 violated (missing or extra units), reported, never thrown', () => {
    const up = checkInvariants(input({ levels: [level({ onHand: 5, available: 5 })] }));
    expect(up.map((v) => `${v.invariant}:${v.detail}`)).toEqual(['I1:missing_units', 'I3:oversell_risk']);
    const down = checkInvariants(input({ levels: [level({ onHand: 2, available: 2 })] }));
    expect(down.map((v) => `${v.invariant}:${v.detail}`)).toEqual(['I1:extra_units']);
  });

  it('I1 gap explained by an open sale without unit is not a violation (8.1)', () => {
    const v = checkInvariants(input({ levels: [level({ onHand: 2, available: 2 })], explained: [explained({ direction: 'surplus', quantity: 1 })] }));
    expect(v).toEqual([]);
  });

  it('I2 — committed below ALLOCATED + waiting', () => {
    const us = [...units('a', I1.id, LOC_A, 2), unit('x', I1.id, LOC_A, { status: 'ALLOCATED' })];
    const v = checkInvariants(input({ units: us, levels: [level({ committed: 1, available: 2 })], uncovered: [{ trackedItemId: I1.id, locationId: LOC_A, quantity: 1 }] }));
    expect(v.map((x) => x.invariant)).toContain('I2');
    const ok = checkInvariants(input({ units: us, levels: [level({ committed: 2, available: 1 })], uncovered: [{ trackedItemId: I1.id, locationId: LOC_A, quantity: 1 }] }));
    expect(ok).toEqual([]);
  });

  it('I3 — available above sellable units minus waiting, unless explained by an unidentified restocked return', () => {
    const v = checkInvariants(input({ levels: [level({ onHand: 4, available: 4 })], explained: [explained({ direction: 'deficit', sourceType: 'return_unidentified' })] }));
    expect(v).toEqual([]);
    const packed = [...units('a', I1.id, LOC_A, 2), unit('p', I1.id, LOC_A, { packedForShipment: true })];
    expect(checkInvariants(input({ units: packed })).map((x) => x.invariant)).toEqual(['I3']);
  });

  it('I4 — reserved below HELD units whose quantity the app moved', () => {
    const us = [...units('a', I1.id, LOC_A, 2), unit('h', I1.id, LOC_A, { status: 'HELD', holdMovedStock: true })];
    expect(checkInvariants(input({ units: us, levels: [level({ available: 2 })] })).map((x) => x.invariant)).toEqual(['I4']);
  });

  it('I5 — quality_control and damaged equal the units in those states', () => {
    const us = [...units('a', I1.id, LOC_A, 2), unit('q', I1.id, LOC_A, { status: 'QUALITY_CONTROL' })];
    const v = checkInvariants(input({ units: us, levels: [level({ available: 2, damaged: 1, onHand: 4 })] }));
    expect(v.filter((x) => x.invariant === 'I5').map((x) => x.detail)).toEqual(['quality_control', 'damaged']);
  });

  it('I6 — unique mode: on_hand 1 iff counted, available 1 only if AVAILABLE and committed nowhere', () => {
    const u = unit('e', I1.id, LOC_A);
    const base = { levels: [], units: [u], uncovered: [], explained: [] };
    expect(checkInvariants({ ...base, uniqueLevels: [{ unitId: 'e', onHand: 1, available: 1, committedAnywhere: false }] })).toEqual([]);
    expect(checkInvariants({ ...base, uniqueLevels: [{ unitId: 'e', onHand: 1, available: 1, committedAnywhere: true }] })[0]?.detail).toBe('available');
    const shipped = { ...u, status: 'SHIPPED' as const };
    expect(checkInvariants({ ...base, units: [shipped], uniqueLevels: [{ unitId: 'e', onHand: 1, available: 0, committedAnywhere: false }] })[0]?.detail).toBe('on_hand');
  });
});

describe('usable deficit and excess — spec 8', () => {
  it('raw gap minus open explained quantities; the cause being resolved is excluded', () => {
    const l = level({ onHand: 5 });
    const ex = [explained({ direction: 'deficit', sourceRef: 'ret-1', quantity: 1 }), explained({ direction: 'deficit', sourceRef: 'unit-9', quantity: 1 })];
    expect(usableDeficit(l, units('a', I1.id, LOC_A, 3), ex)).toBe(0);
    expect(usableDeficit(l, units('a', I1.id, LOC_A, 3), ex, 'unit-9')).toBe(1);
    expect(usableExcess(level({ onHand: 1 }), units('a', I1.id, LOC_A, 3), [explained({ quantity: 1 })])).toBe(1);
  });

  it('S-09 auto: to-verify units resolved oldest first within the usable deficit', () => {
    const tv = [
      { unit: unit('t2', I1.id, LOC_A, { status: 'TO_VERIFY' }), since: T0 + 2 },
      { unit: unit('t1', I1.id, LOC_A, { status: 'TO_VERIFY' }), since: T0 + 1 },
      { unit: unit('t3', I1.id, LOC_A, { status: 'TO_VERIFY' }), since: T0 + 3 },
    ];
    expect(planAutomaticToVerifyResolution('auto', tv, 2)).toEqual(['t1', 't2']);
    expect(planAutomaticToVerifyResolution('auto', tv, 0)).toEqual([]);
    expect(planAutomaticToVerifyResolution('manual', tv, 2)).toEqual([]);
  });

  it('S-25 on decision: the initialization phase ends only on the merchant decision', () => {
    expect(initializationShouldEnd('auto', true, false)).toBe(true);
    expect(initializationShouldEnd('auto', false, false)).toBe(false);
    expect(initializationShouldEnd('on_decision', true, false)).toBe(false);
    expect(initializationShouldEnd('on_decision', true, true)).toBe(true);
  });
});

describe('allocation ↔ unit consistency — spec 11.2', () => {
  const alloc = (id: string, unitId: string, status: 'active' | 'fulfilled' | 'released' | 'returned') => ({ id, unitId, status });

  it('accepts the states of the rule, including RETURN_PENDING with its fulfilled allocation and a historical sale', () => {
    const units = [
      { id: 'u1', status: 'ALLOCATED' as const },
      { id: 'u2', status: 'SHIPPED' as const },
      { id: 'u3', status: 'RETURN_PENDING' as const },
      { id: 'u4', status: 'SHIPPED' as const },
      { id: 'u5', status: 'AVAILABLE' as const },
    ];
    const allocations = [alloc('a1', 'u1', 'active'), alloc('a2', 'u2', 'fulfilled'), alloc('a3', 'u3', 'fulfilled'), alloc('a5', 'u5', 'released'), alloc('a6', 'u5', 'returned')];
    expect(checkAllocationConsistency(units, allocations)).toEqual([]);
  });

  it('reports every breach, never throws', () => {
    const units = [
      { id: 'u1', status: 'ALLOCATED' as const },
      { id: 'u2', status: 'SHIPPED' as const },
      { id: 'u3', status: 'AVAILABLE' as const },
      { id: 'u4', status: 'TO_VERIFY' as const },
    ];
    const allocations = [alloc('a2', 'u2', 'active'), alloc('a3', 'u3', 'active'), alloc('a4', 'u4', 'fulfilled')];
    expect(checkAllocationConsistency(units, allocations).map((v) => `${v.unitId}:${v.detail}`)).toEqual([
      'u1:allocated_without_one_active',
      'u2:shipped_with_active',
      'u3:engaged_in_other_state',
      'u4:engaged_in_other_state',
    ]);
  });
});
