import { describe, expect, it } from 'vitest';
import { resolveDesignation, suggestRefs, unitForEnter } from '../src';

const units = [
  { id: '1', ref: 'SN-2024-0001' },
  { id: '2', ref: 'SN-2024-0002' },
  { id: '3', ref: 'SN-2025-A001' },
  { id: '4', ref: 'xy 77 b' },
];

describe('resolveDesignation (15.5)', () => {
  it('is empty on blank input', () => {
    expect(resolveDesignation('   ', units)).toEqual({ kind: 'empty' });
  });

  it('resolves a full ref, ignoring case and spaces (S-36 defaults)', () => {
    expect(resolveDesignation('sn-2024-0002', units)).toEqual({ kind: 'exact', unit: units[1] });
    expect(resolveDesignation('XY77B', units)).toEqual({ kind: 'exact', unit: units[3] });
    expect(resolveDesignation(' xy 77 b ', units)).toEqual({ kind: 'exact', unit: units[3] });
  });

  it('resolves 4 characters when they end exactly one proposed ref', () => {
    expect(resolveDesignation('A001', units)).toEqual({ kind: 'suffix', unit: units[2] });
    expect(resolveDesignation('0002', units)).toEqual({ kind: 'suffix', unit: units[1] });
  });

  it('flags ambiguous last 4 characters', () => {
    const r = resolveDesignation('2001', [{ id: 'a', ref: 'A-2001' }, { id: 'b', ref: 'B-2001' }]);
    expect(r.kind).toBe('ambiguous');
    expect(r.kind === 'ambiguous' && r.units.map((u) => u.id)).toEqual(['a', 'b']);
  });

  it('does not resolve fewer than 4 characters, nor 5+ characters that are not a full ref', () => {
    expect(resolveDesignation('01', units).kind).toBe('too_short');
    expect(resolveDesignation('001', units).kind).toBe('too_short');
    expect(resolveDesignation('0002X', units).kind).toBe('unknown');
    expect(resolveDesignation('2024-0001', units).kind).toBe('unknown');
  });

  it('is unknown for 4 characters matching nothing', () => {
    expect(resolveDesignation('ZZZZ', units).kind).toBe('unknown');
  });

  it('a full-ref match wins over a suffix match', () => {
    const list = [{ id: 'a', ref: 'ABCD' }, { id: 'b', ref: 'XABCD' }];
    expect(resolveDesignation('ABCD', list)).toEqual({ kind: 'exact', unit: list[0] });
  });
});

describe('suggestRefs', () => {
  it('suggests nothing under 3 characters', () => {
    expect(suggestRefs('SN', units)).toEqual([]);
  });

  it('suggests from 3 characters, best matches first (exact, suffix, prefix, contains)', () => {
    const list = [{ id: 'c', ref: 'ZZ-ABC-9' }, { id: 'b', ref: 'ABC-1' }, { id: 'a', ref: 'XXABC' }, { id: 'd', ref: 'ABC' }];
    expect(suggestRefs('abc', list).map((u) => u.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('honours the limit', () => {
    expect(suggestRefs('SN-', units, {}, 2)).toHaveLength(2);
  });
});

describe('unitForEnter', () => {
  it('returns a unit only for a typed ref that designates exactly one', () => {
    expect(unitForEnter('SN-2024-0001', units)).toBe(units[0]);
    expect(unitForEnter('A001', units)).toBe(units[2]);
  });

  it('never returns a unit for a partial text, even when suggestions exist', () => {
    expect(suggestRefs('SN-2024', units).length).toBeGreaterThan(0);
    expect(unitForEnter('SN-2024', units)).toBeNull();
    expect(unitForEnter('SN-', units)).toBeNull();
    expect(unitForEnter('', units)).toBeNull();
  });
});
