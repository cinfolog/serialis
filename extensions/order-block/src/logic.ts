import type { Allocation, OrderAllocationsResponse } from '@serialis/contract';

type Line = OrderAllocationsResponse['lines'][number];

/** One displayed row under a tracked line: an allocated unit, or a unit still missing (F15: one row per unit). */
export type UnitRow =
  | { kind: 'allocation'; allocation: Allocation }
  | { kind: 'missing'; position: number };

export interface LineView {
  line: Line;
  rows: UnitRow[];
  /** Units still to allocate for this line (never negative). */
  missing: number;
}

/**
 * Lines that carry tracking, each with one row per allocation then one row per missing unit.
 * Released and returned allocations are history: they are listed after the active ones.
 */
export function buildLineViews(res: OrderAllocationsResponse): LineView[] {
  return res.lines
    .filter((l) => l.tracked)
    .map((line) => {
      const rank = (a: Allocation) => (a.status === 'active' || a.status === 'fulfilled' ? 0 : 1);
      const allocations = [...line.allocations].sort((a, b) => rank(a) - rank(b) || a.allocatedAt.localeCompare(b.allocatedAt));
      const missing = Math.max(0, line.missing);
      const rows: UnitRow[] = allocations.map((allocation) => ({ kind: 'allocation', allocation }));
      for (let i = 0; i < missing; i++) rows.push({ kind: 'missing', position: i + 1 });
      return { line, rows, missing };
    });
}

export function untrackedLineCount(res: OrderAllocationsResponse): number {
  return res.lines.filter((l) => !l.tracked).length;
}

/** Locale key of the origin of an allocation (15.6: commande, manuelle, API, caisse...). */
export function originKey(source: Allocation['source']): string {
  return `orderBlock.origin_${source}`;
}

export type BadgeTone = 'info' | 'success' | 'neutral' | 'warning';

export function statusView(status: Allocation['status']): { key: string; tone: BadgeTone } {
  switch (status) {
    case 'active': return { key: 'orderBlock.status_active', tone: 'info' };
    case 'fulfilled': return { key: 'orderBlock.status_fulfilled', tone: 'success' };
    case 'released': return { key: 'orderBlock.status_released', tone: 'neutral' };
    case 'returned': return { key: 'orderBlock.status_returned', tone: 'warning' };
  }
}

/** Polling policy while the order is being synchronized ("attribution en cours"). */
export const POLL_INTERVAL_MS = 3000;
export const MAX_POLLS = 20;

export function shouldPoll(syncState: OrderAllocationsResponse['syncState'], polls: number): boolean {
  return syncState === 'pending' && polls < MAX_POLLS;
}

/** The "Modifier les unités" button is useful when a line is tracked. */
export function canEdit(res: OrderAllocationsResponse): boolean {
  return res.lines.some((l) => l.tracked);
}
