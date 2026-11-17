/**
 * Ref helpers shared by the extensions: normalization (S-36), list parsing (15.5 "Collage d'une liste")
 * and line classification before an add. The server stays authoritative; these rules only give early feedback.
 */

export interface NormalizeOptions {
  /** S-36 `strip_spaces` (default: true). */
  stripSpaces?: boolean;
  /** S-36 `normalize_upper` (default: true). */
  upper?: boolean;
}

export function normalizeRef(input: string, opts: NormalizeOptions = {}): string {
  let s = input.trim();
  if (opts.stripSpaces ?? true) s = s.replace(/\s+/g, '');
  if (opts.upper ?? true) s = s.toUpperCase();
  return s;
}

/** Maximum refs per `POST /units/batch` (19.4: batches of 1,000). */
export const MAX_BATCH_REFS = 1000;
/** Client-side format guard; the type-specific validation (S-37) is done by the server. */
export const MAX_REF_LENGTH = 128;

/** Splits a pasted list: one ref per line, spaces, commas and semicolons accepted as separators. */
export function parseRefList(text: string): string[] {
  return text.split(/[\s,;]+/).filter((s) => s.length > 0);
}

export type RefLineStatus = 'ready' | 'duplicate' | 'known' | 'invalid';

export interface RefLine {
  /** 0-based position in the pasted list (matches `rejected[].index` of the batch response). */
  index: number;
  ref: string;
  status: RefLineStatus;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Status of each pasted ref: `invalid` (too long or control characters), `duplicate` (same normalized
 * ref earlier in the list), `known` (already registered for this variant), otherwise `ready`.
 */
export function classifyRefs(refs: string[], knownRefs: Iterable<string>, opts: NormalizeOptions = {}): RefLine[] {
  const known = new Set<string>();
  for (const k of knownRefs) known.add(normalizeRef(k, opts));
  const seen = new Set<string>();
  return refs.map((ref, index) => {
    if (ref.length > MAX_REF_LENGTH || CONTROL_CHARS.test(ref)) return { index, ref, status: 'invalid' };
    const n = normalizeRef(ref, opts);
    if (n.length === 0) return { index, ref, status: 'invalid' };
    if (seen.has(n)) return { index, ref, status: 'duplicate' };
    seen.add(n);
    if (known.has(n)) return { index, ref, status: 'known' };
    return { index, ref, status: 'ready' };
  });
}

export function countByStatus(lines: RefLine[]): Record<RefLineStatus, number> {
  const out: Record<RefLineStatus, number> = { ready: 0, duplicate: 0, known: 0, invalid: 0 };
  for (const l of lines) out[l.status]++;
  return out;
}
