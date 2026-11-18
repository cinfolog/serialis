import { DEFAULT_NORMALIZATION, normalizeIdentifier } from './identifiers.js';
import type { IdentifierNormalization } from './settings.js';
import type { UnitIdentifier } from './types.js';

/**
 * Designation of a physical unit by a typed ref — spec 15.5 (single rule used for returns,
 * late designation, POS…): the full ref, or its last 4 characters when they are unique among
 * the proposed units. A prefix is never validated, an ambiguous input is rejected.
 */

export interface DesignationCandidate {
  readonly unitId: string;
  readonly identifiers: readonly UnitIdentifier[];
}

export type DesignationResult =
  | { ok: true; unitId: string; matchedBy: 'full' | 'last4' }
  | { ok: false; reason: 'empty' | 'not_found' | 'ambiguous'; unitIds: readonly string[] };

export const LAST_CHARS = 4;

function normalize(value: string, normalization: IdentifierNormalization): string {
  // Matching is always case-insensitive (15.5), whatever the stored normalization.
  return normalizeIdentifier(value, { ...normalization, normalizeUpper: true });
}

export function designateUnit(
  input: string,
  candidates: readonly DesignationCandidate[],
  normalization: IdentifierNormalization = DEFAULT_NORMALIZATION,
): DesignationResult {
  const typed = normalize(input, normalization);
  if (typed === '') return { ok: false, reason: 'empty', unitIds: [] };

  const matches = new Map<string, 'full' | 'last4'>();
  for (const c of candidates) {
    for (const id of c.identifiers) {
      if (id.retired) continue;
      const value = normalize(id.value, normalization);
      if (value === typed) {
        matches.set(c.unitId, 'full');
      } else if (typed.length === LAST_CHARS && value.length > LAST_CHARS && value.endsWith(typed) && !matches.has(c.unitId)) {
        matches.set(c.unitId, 'last4');
      }
    }
  }

  const unitIds = [...matches.keys()].sort();
  if (unitIds.length === 0) return { ok: false, reason: 'not_found', unitIds };
  if (unitIds.length > 1) return { ok: false, reason: 'ambiguous', unitIds };
  const unitId = unitIds[0] as string;
  return { ok: true, unitId, matchedBy: matches.get(unitId) as 'full' | 'last4' };
}
