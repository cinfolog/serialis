import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Gid, Unit } from '@serialis/contract';
import { MAX_BATCH_REFS, normalizeRef, type ApiClient } from '@serialis/extensions-shared';

/** Pause after the last keystroke before asking the server (one call per pause, not per key). */
export const CHECK_DEBOUNCE_MS = 500;
/** Refs found by the server check whose unit (location, state) is looked up for the message. */
export const MAX_DETAIL_LOOKUPS = 5;

type Verdict = 'ok' | 'known' | 'invalid';

export interface RefCheck {
  /** Normalized refs the server reports as already registered for the shop (uniqueness scope S-35). */
  known: string[];
  /** Normalized refs refused by the server's type rules (S-37). */
  invalid: string[];
  /** Unit of a known ref, when it could be read (normalized ref -> unit). */
  units: ReadonlyMap<string, Unit>;
  checking: boolean;
}

/**
 * Live duplicate check of the typed refs (decision 3): after a pause, the refs not yet checked are sent to
 * `POST /units/batch/check` (writes nothing). Verdicts are kept for the session of the modal, so a ref is checked
 * once; the uniqueness scope does not depend on the location. A failed check flags nothing: the batch itself
 * stays the final guard (`identifier_conflict` per ref).
 */
export function useRefCheck(api: ApiClient, variantGid: Gid, locationId: string, candidates: string[], delay = CHECK_DEBOUNCE_MS): RefCheck {
  const [verdicts, setVerdicts] = useState<ReadonlyMap<string, Verdict>>(new Map());
  const [units, setUnits] = useState<ReadonlyMap<string, Unit>>(new Map());
  const [checking, setChecking] = useState(false);

  const pending = useMemo(() => {
    const out = new Map<string, string>();
    for (const ref of candidates) {
      const n = normalizeRef(ref);
      if (!verdicts.has(n) && !out.has(n)) out.set(n, ref);
    }
    return [...out.values()].slice(0, MAX_BATCH_REFS);
  }, [candidates, verdicts]);
  const key = pending.join('\n');

  useEffect(() => {
    if (pending.length === 0 || !locationId) return;
    const ctrl = new AbortController();
    const id = setTimeout(() => {
      setChecking(true);
      void (async () => {
        try {
          const res = await api.checkUnitsBatch(
            { variantGid, locationId, refs: pending, alreadyCounted: false, mode: 'per_item' },
            { signal: ctrl.signal },
          );
          if (ctrl.signal.aborted) return;
          const next = new Map<string, Verdict>();
          for (const r of res.rows) {
            next.set(normalizeRef(r.ref), r.status === 'already_known' ? 'known' : r.status === 'invalid_format' ? 'invalid' : 'ok');
          }
          setVerdicts((prev) => new Map([...prev, ...next]));
          const toLookUp = [...next].filter(([, v]) => v === 'known').map(([n]) => n).slice(0, MAX_DETAIL_LOOKUPS);
          const found = await Promise.all(
            toLookUp.map((n) => api.lookup(n, { signal: ctrl.signal }).then((r) => r.unit, () => null)),
          );
          if (ctrl.signal.aborted) return;
          setUnits((prev) => {
            const m = new Map(prev);
            found.forEach((u, i) => {
              if (u) m.set(toLookUp[i]!, u);
            });
            return m;
          });
        } catch {
          /* flag nothing: the server refuses the duplicates when the batch is sent */
        } finally {
          if (!ctrl.signal.aborted) setChecking(false);
        }
      })();
    }, delay);
    return () => {
      clearTimeout(id);
      ctrl.abort();
      setChecking(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, locationId, variantGid, delay]);

  return useMemo(() => {
    const known: string[] = [];
    const invalid: string[] = [];
    for (const [n, v] of verdicts) {
      if (v === 'known') known.push(n);
      else if (v === 'invalid') invalid.push(n);
    }
    return { known, invalid, units, checking };
  }, [verdicts, units, checking]);
}
