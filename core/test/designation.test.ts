import { describe, expect, it } from 'vitest';
import { designateUnit, type DesignationCandidate } from '../src/designation.js';

const c = (unitId: string, ...values: string[]): DesignationCandidate => ({
  unitId,
  identifiers: values.map((value, i) => ({ type: i === 0 ? 'serial' : 'imei', value, primary: i === 0 })),
});

const candidates = [c('u1', 'SN-UR500-M-51203'), c('u2', 'SN-UR500-M-51288'), c('u3', 'SN-UR500-L-77203')];

describe('designation by typed ref — spec 15.5', () => {
  it('accepts the full ref, trimmed and case-insensitive', () => {
    expect(designateUnit('  sn-ur500-m-51288 ', candidates)).toEqual({ ok: true, unitId: 'u2', matchedBy: 'full' });
  });

  it('accepts the last 4 characters when they are unique among the candidates', () => {
    expect(designateUnit('1288', candidates)).toEqual({ ok: true, unitId: 'u2', matchedBy: 'last4' });
  });

  it('rejects the last 4 characters when several candidates end with them', () => {
    expect(designateUnit('7203', [...candidates, c('u4', 'XX-17203')])).toEqual({
      ok: false,
      reason: 'ambiguous',
      unitIds: ['u3', 'u4'],
    });
    // 1203 vs 7203: different, so unique.
    expect(designateUnit('1203', candidates)).toMatchObject({ ok: true, unitId: 'u1' });
  });

  it('never validates a prefix or a partial infix', () => {
    expect(designateUnit('SN-UR500-M', candidates)).toMatchObject({ ok: false, reason: 'not_found' });
    expect(designateUnit('SN-U', candidates)).toMatchObject({ ok: false, reason: 'not_found' });
    expect(designateUnit('120', candidates)).toMatchObject({ ok: false, reason: 'not_found' });
    expect(designateUnit('51203X', candidates)).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('rejects an empty input', () => {
    expect(designateUnit('   ', candidates)).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('matches any active identifier of a unit, never a retired one', () => {
    const withImei = [c('u1', 'SN-1', '356938035643809'), c('u2', 'SN-2')];
    expect(designateUnit('356938035643809', withImei)).toMatchObject({ ok: true, unitId: 'u1' });
    const retired: DesignationCandidate = {
      unitId: 'u9',
      identifiers: [
        { type: 'serial', value: 'NEW-0001', primary: true },
        { type: 'serial', value: 'OLD-0002', primary: false, retired: true },
      ],
    };
    expect(designateUnit('OLD-0002', [retired])).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('a 4-character input equal to a full ref and to the end of another ref is ambiguous', () => {
    expect(designateUnit('ABCD', [c('u1', 'ABCD'), c('u2', 'XYZ-ABCD')])).toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it('strips inner spaces by default (S-36)', () => {
    expect(designateUnit('SN-UR500-M-51 203', candidates)).toMatchObject({ ok: true, unitId: 'u1' });
    expect(designateUnit('SN-UR500-M-51 203', candidates, { stripSpaces: false, normalizeUpper: true })).toMatchObject({
      ok: false,
    });
  });
});
