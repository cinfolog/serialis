import { describe, expect, it } from 'vitest';
import { classifyRefs, countByStatus, normalizeRef, parseRefList } from '../src';

describe('normalizeRef (S-36)', () => {
  it('strips spaces and upper-cases by default', () => {
    expect(normalizeRef(' ab 12\tc ')).toBe('AB12C');
  });
  it('can keep spaces and case', () => {
    expect(normalizeRef(' ab 12 ', { stripSpaces: false, upper: false })).toBe('ab 12');
  });
});

describe('parseRefList (15.5)', () => {
  it('accepts lines, spaces, commas and semicolons as separators', () => {
    expect(parseRefList('A1\nB2, C3;D4  E5\r\n\n,F6;')).toEqual(['A1', 'B2', 'C3', 'D4', 'E5', 'F6']);
  });
  it('returns an empty list for blank text', () => {
    expect(parseRefList(' \n ')).toEqual([]);
  });
});

describe('classifyRefs', () => {
  it('flags duplicates in the list, known refs and invalid format', () => {
    const lines = classifyRefs(['A1', 'a1', 'B2', 'C3', 'X'.repeat(200), 'D\u00004'], ['c3']);
    expect(lines.map((l) => l.status)).toEqual(['ready', 'duplicate', 'ready', 'known', 'invalid', 'invalid']);
    expect(lines.map((l) => l.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(countByStatus(lines)).toEqual({ ready: 2, duplicate: 1, known: 1, invalid: 2 });
  });

  it('does not count a known ref twice as duplicate of the known one', () => {
    const lines = classifyRefs(['K1', 'K1'], ['K1']);
    expect(lines.map((l) => l.status)).toEqual(['known', 'duplicate']);
  });
});
