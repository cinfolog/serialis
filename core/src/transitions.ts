import type { UnitState } from './states.js';

/**
 * Single source of truth for allowed unit state changes — spec sections 7.2 and 7.3.
 *
 * This table is used by the API, the admin UI and, through the generated seed
 * `db/shop/0002_allowed_transitions.sql`, by the SQLite triggers that reject any
 * other change of `units.status`. Run `pnpm gen:transitions` after editing it.
 *
 * The database only sees state pairs. Pairs marked `guarded` are allowed by the
 * database but must also pass a guard in `applyTransition` (the trigger cannot see
 * the business context: same allocation, delay S-42, etc.).
 */

/** `null` = creation of a unit. */
export type FromState = UnitState | null;

export interface TransitionRule {
  from: FromState;
  to: readonly UnitState[];
  /** Pairs that need a business guard beyond the state pair. */
  guarded?: readonly UnitState[];
}

export const TRANSITIONS: readonly TransitionRule[] = [
  // Creation: without reception, with reception, already counted in Shopify,
  // migration of a past sale, return of a sale made before tracking started.
  { from: null, to: ['INCOMING', 'AVAILABLE', 'QUALITY_CONTROL', 'DAMAGED', 'SHIPPED', 'SCRAPPED', 'LOST'] },
  { from: 'INCOMING', to: ['AVAILABLE', 'QUALITY_CONTROL', 'DAMAGED', 'SCRAPPED', 'UNTRACKED'] },
  {
    from: 'AVAILABLE',
    // AVAILABLE → AVAILABLE: observed transfer between locations, or reclassification to another variant.
    to: ['AVAILABLE', 'ALLOCATED', 'SHIPPED', 'HELD', 'QUALITY_CONTROL', 'DAMAGED', 'SCRAPPED', 'LOST', 'IN_TRANSIT', 'UNTRACKED'],
  },
  { from: 'ALLOCATED', to: ['AVAILABLE', 'SHIPPED', 'TO_VERIFY', 'DAMAGED', 'LOST'] },
  {
    from: 'SHIPPED',
    to: ['ALLOCATED', 'RETURN_PENDING', 'AVAILABLE', 'QUALITY_CONTROL', 'DAMAGED'],
    // Only a fulfillment cancellation on the same allocation, or a shipment designation fix (7.3).
    guarded: ['ALLOCATED'],
  },
  { from: 'HELD', to: ['AVAILABLE', 'ALLOCATED', 'DAMAGED', 'LOST', 'SCRAPPED', 'UNTRACKED'] },
  { from: 'QUALITY_CONTROL', to: ['QUALITY_CONTROL', 'AVAILABLE', 'DAMAGED', 'SCRAPPED', 'LOST', 'IN_TRANSIT', 'UNTRACKED'] },
  { from: 'DAMAGED', to: ['DAMAGED', 'QUALITY_CONTROL', 'AVAILABLE', 'SCRAPPED', 'LOST', 'IN_TRANSIT', 'UNTRACKED'] },
  { from: 'IN_TRANSIT', to: ['AVAILABLE', 'QUALITY_CONTROL', 'DAMAGED', 'LOST'] },
  { from: 'RETURN_PENDING', to: ['SHIPPED', 'AVAILABLE', 'QUALITY_CONTROL', 'DAMAGED', 'SCRAPPED', 'LOST'] },
  { from: 'TO_VERIFY', to: ['AVAILABLE', 'QUALITY_CONTROL', 'DAMAGED', 'SCRAPPED', 'LOST', 'UNTRACKED'] },
  { from: 'LOST', to: ['AVAILABLE', 'QUALITY_CONTROL', 'DAMAGED'] },
  {
    from: 'SCRAPPED',
    to: ['AVAILABLE', 'QUALITY_CONTROL', 'DAMAGED'],
    // Undo of a scrap made by mistake within S-42, or reception of a unit whose cancellation was wrong.
    guarded: ['AVAILABLE', 'QUALITY_CONTROL', 'DAMAGED'],
  },
  { from: 'UNTRACKED', to: ['AVAILABLE', 'QUALITY_CONTROL', 'DAMAGED', 'LOST', 'SCRAPPED'] },
];

const key = (from: FromState, to: UnitState) => `${from ?? ''}>${to}`;

const ALLOWED = new Map<string, { guarded: boolean }>();
for (const rule of TRANSITIONS) {
  for (const to of rule.to) {
    ALLOWED.set(key(rule.from, to), { guarded: rule.guarded?.includes(to) ?? false });
  }
}

export type TransitionCheck =
  | { ok: true; guarded: boolean }
  | { ok: false; reason: 'forbidden_transition' };

/** Is the state pair allowed at all (what the database trigger enforces)? */
export function checkTransition(from: FromState, to: UnitState): TransitionCheck {
  const hit = ALLOWED.get(key(from, to));
  return hit ? { ok: true, guarded: hit.guarded } : { ok: false, reason: 'forbidden_transition' };
}

/** All allowed pairs, sorted — used to generate the SQL seed and to compare it in tests. */
export function allowedPairs(): Array<{ from: FromState; to: UnitState; guarded: boolean }> {
  return TRANSITIONS.flatMap((r) => r.to.map((to) => ({ from: r.from, to, guarded: r.guarded?.includes(to) ?? false }))).sort(
    (a, b) => key(a.from, a.to).localeCompare(key(b.from, b.to)),
  );
}

/** SQL seed for the `allowed_transitions` table (empty `from_status` = creation). */
export function allowedTransitionsSql(): string {
  const rows = allowedPairs().map((p) => `  ('${p.from ?? ''}', '${p.to}', ${p.guarded ? 1 : 0})`);
  return [
    '-- Generated from core/src/transitions.ts by `pnpm gen:transitions`. Do not edit by hand.',
    'DELETE FROM allowed_transitions;',
    'INSERT INTO allowed_transitions (from_status, to_status, guarded) VALUES',
    rows.join(',\n') + ';',
    '',
  ].join('\n');
}
