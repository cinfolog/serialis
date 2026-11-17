import { normalizeRef, type NormalizeOptions } from './refs';

/**
 * Designation rule (spec 15.5): a ref is designated in full, or by its last 4 characters when they are
 * unique among the proposed units. Autocomplete (from 3 characters) only suggests; it never validates.
 */

export const SUGGESTION_MIN_CHARS = 3;
export const SUFFIX_LENGTH = 4;
export const MAX_SUGGESTIONS = 8;

export interface Designable {
  id: string;
  ref: string;
}

export type Resolution<U extends Designable> =
  /** Nothing typed. */
  | { kind: 'empty' }
  /** Typed ref equals the full ref of one unit. */
  | { kind: 'exact'; unit: U }
  /** Typed 4 characters equal the end of exactly one proposed ref. */
  | { kind: 'suffix'; unit: U }
  /** Typed 4 characters end several proposed refs: ask for more characters. */
  | { kind: 'ambiguous'; units: U[] }
  /** Fewer than 3 characters typed, or fewer than 4 and no exact match. */
  | { kind: 'too_short' }
  | { kind: 'unknown' };

/**
 * Resolves what the person typed against the units proposed for the action
 * (right variant, right location, compatible state: the caller filters).
 * A full-ref match always wins over a suffix match.
 */
export function resolveDesignation<U extends Designable>(
  input: string,
  candidates: readonly U[],
  opts: NormalizeOptions = {},
): Resolution<U> {
  const typed = normalizeRef(input, opts);
  if (typed.length === 0) return { kind: 'empty' };

  const exact = candidates.filter((u) => normalizeRef(u.ref, opts) === typed);
  if (exact.length === 1) return { kind: 'exact', unit: exact[0]! };
  if (exact.length > 1) return { kind: 'ambiguous', units: exact };

  if (typed.length < SUGGESTION_MIN_CHARS) return { kind: 'too_short' };
  if (typed.length === SUFFIX_LENGTH) {
    const bySuffix = candidates.filter((u) => normalizeRef(u.ref, opts).endsWith(typed));
    if (bySuffix.length === 1) return { kind: 'suffix', unit: bySuffix[0]! };
    if (bySuffix.length > 1) return { kind: 'ambiguous', units: bySuffix };
  }
  if (typed.length < SUFFIX_LENGTH) return { kind: 'too_short' };
  return { kind: 'unknown' };
}

/**
 * Autocomplete suggestions from 3 characters: refs that start with, end with or contain the input,
 * best matches first. Suggestions are hints: selecting one only fills the field.
 */
export function suggestRefs<U extends Designable>(
  input: string,
  candidates: readonly U[],
  opts: NormalizeOptions = {},
  limit: number = MAX_SUGGESTIONS,
): U[] {
  const typed = normalizeRef(input, opts);
  if (typed.length < SUGGESTION_MIN_CHARS) return [];
  const scored: Array<{ unit: U; score: number; norm: string }> = [];
  for (const unit of candidates) {
    const norm = normalizeRef(unit.ref, opts);
    let score: number;
    if (norm === typed) score = 0;
    else if (norm.endsWith(typed)) score = 1;
    else if (norm.startsWith(typed)) score = 2;
    else if (norm.includes(typed)) score = 3;
    else continue;
    scored.push({ unit, score, norm });
  }
  scored.sort((a, b) => a.score - b.score || a.norm.localeCompare(b.norm));
  return scored.slice(0, limit).map((s) => s.unit);
}

/** What pressing Enter does: it submits only a ref that designates one unit; a suggestion never counts. */
export function unitForEnter<U extends Designable>(input: string, candidates: readonly U[], opts: NormalizeOptions = {}): U | null {
  const r = resolveDesignation(input, candidates, opts);
  return r.kind === 'exact' || r.kind === 'suffix' ? r.unit : null;
}
