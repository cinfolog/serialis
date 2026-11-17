import type { Allocation, Gid, Unit } from './types.js';

/** Order metafield `serialis.units`, version 1 — spec 13.4 and EF-18. A copy: the truth stays in the base. */

export const METAFIELD_NAMESPACE = 'serialis';
export const METAFIELD_KEY = 'units';

export type MetafieldUnitStatus = 'allocated' | 'shipped' | 'returned';

export interface MetafieldUnitsV1 {
  readonly version: 1;
  readonly lines: readonly {
    readonly line_item_id: Gid;
    readonly units: readonly {
      readonly unit_id: string;
      readonly status: MetafieldUnitStatus;
      readonly identifiers: readonly { readonly type: string; readonly value: string; readonly primary: boolean }[];
    }[];
  }[];
}

const STATUS: Partial<Record<Allocation['status'], MetafieldUnitStatus>> = {
  active: 'allocated',
  fulfilled: 'shipped',
  returned: 'returned',
};

export function compareAllocations(a: Allocation, b: Allocation): number {
  return a.allocatedAt - b.allocatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * One element per line (in the order's line order) and one entry per unit, released
 * allocations excluded. Returns null when no line has a unit.
 */
export function buildUnitsMetafield(
  lineItemGids: readonly Gid[],
  allocations: readonly Allocation[],
  unitsById: ReadonlyMap<string, Unit>,
): MetafieldUnitsV1 | null {
  const lines = lineItemGids
    .map((lineItemGid) => {
      const units = allocations
        .filter((a) => a.lineItemGid === lineItemGid && STATUS[a.status] !== undefined)
        .sort(compareAllocations)
        .map((a) => {
          const unit = unitsById.get(a.unitId);
          const identifiers = (unit?.identifiers ?? [])
            .filter((i) => !i.retired)
            .slice()
            .sort((x, y) => Number(y.primary) - Number(x.primary))
            .map((i) => ({ type: i.type, value: i.value, primary: i.primary }));
          return { unit_id: a.unitId, status: STATUS[a.status] as MetafieldUnitStatus, identifiers };
        });
      return { line_item_id: lineItemGid, units };
    })
    .filter((l) => l.units.length > 0);
  return lines.length === 0 ? null : { version: 1, lines };
}

export function serializeMetafield(value: MetafieldUnitsV1 | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Same content, whatever the key order or spacing; an unreadable current value always differs. */
export function sameMetafieldContent(computed: string | null, current: string | null): boolean {
  if (computed === null || current === null) return computed === current;
  try {
    return canonical(JSON.parse(computed)) === canonical(JSON.parse(current));
  } catch {
    return false;
  }
}
