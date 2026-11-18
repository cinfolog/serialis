import type {
  Allocation,
  CreateAllocationRequest,
  Gid,
  OrderAllocationsResponse,
  ReplaceAllocationRequest,
  Unit,
} from '@serialis/contract';
import type { ApiClient } from '@serialis/extensions-shared';

export type Line = OrderAllocationsResponse['lines'][number];

/** What the person is doing: allocate a missing unit, replace an allocation, or remove it (spec 15.6). */
export type PanelAction =
  | { type: 'allocate'; line: Line }
  | { type: 'replace'; line: Line; allocation: Allocation }
  | { type: 'remove'; line: Line; allocation: Allocation };

/** Only tracked lines can be edited. */
export function editableLines(res: OrderAllocationsResponse): Line[] {
  return res.lines.filter((l) => l.tracked);
}

/** An allocation can be replaced or removed until the unit is fulfilled (released and returned ones are history). */
export function isEditable(a: Allocation): boolean {
  return a.status === 'active';
}

/** Units that can still be chosen for a line: available units of the variant, first in first out (S-05 default). */
export function sortCandidates(units: Unit[]): Unit[] {
  return units
    .filter((u) => u.state === 'AVAILABLE')
    .sort((a, b) => (a.receivedAt ?? '').localeCompare(b.receivedAt ?? '') || a.ref.localeCompare(b.ref));
}

export interface Candidates {
  units: Unit[];
  /** True when the list was cut: a typed ref that matches nothing is then sent as typed for the server to decide. */
  truncated: boolean;
}

export async function loadCandidates(api: ApiClient, variantGid: Gid, signal?: AbortSignal): Promise<Candidates> {
  const res = await api.listAllUnits({ variant: variantGid, state: 'AVAILABLE' }, { maxPages: 4, ...(signal ? { signal } : {}) });
  return { units: sortCandidates(res.items), truncated: res.truncated };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** The unit chosen in the list or designated by typing, or the raw text when the list was truncated. */
export type Choice = { unitId: string } | { ref: string };

export type PlannedCall =
  | { kind: 'create'; req: CreateAllocationRequest }
  | { kind: 'replace'; id: string; req: ReplaceAllocationRequest }
  | { kind: 'remove'; id: string };

export function planCall(orderGid: Gid, action: PanelAction, choice: Choice | null): PlannedCall | null {
  if (action.type === 'remove') return { kind: 'remove', id: action.allocation.id };
  if (!choice) return null;
  if (action.type === 'allocate') {
    return { kind: 'create', req: { orderGid, lineItemGid: action.line.lineItemGid, ...choice } };
  }
  return { kind: 'replace', id: action.allocation.id, req: { ...choice } };
}

export async function runCall(api: ApiClient, call: PlannedCall, idempotencyKey: string): Promise<void> {
  const opts = { idempotencyKey };
  if (call.kind === 'create') await api.createAllocation(call.req, opts);
  else if (call.kind === 'replace') await api.replaceAllocation(call.id, call.req, opts);
  else await api.deleteAllocation(call.id);
}

// ---------------------------------------------------------------------------
// Effect announced before confirmation (15.6, 15.7)
// ---------------------------------------------------------------------------

export interface Effect {
  /** Locale key under `orderAction.effect_*`. */
  key: string;
  vars: Record<string, string | number>;
}

/**
 * Effect on units and on Shopify stock, announced before the confirmation button.
 * `chosen` is the unit the person picked or typed (null when still undetermined).
 * Allocations never write Shopify stock: the units only move between ALLOCATED and AVAILABLE.
 */
export function describeEffect(action: PanelAction, chosen: { ref: string } | null): Effect | null {
  const line = action.line.title;
  switch (action.type) {
    case 'allocate':
      return chosen ? { key: 'orderAction.effect_allocate', vars: { ref: chosen.ref, line } } : null;
    case 'replace':
      return chosen
        ? { key: 'orderAction.effect_replace', vars: { oldRef: action.allocation.ref, ref: chosen.ref, line } }
        : null;
    case 'remove':
      return { key: 'orderAction.effect_remove', vars: { ref: action.allocation.ref, line } };
  }
}
