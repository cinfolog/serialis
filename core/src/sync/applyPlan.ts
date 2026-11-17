import type { Allocation, Anomaly, Millis, Unit } from '../types.js';
import type { SyncPlan, SyncState } from './plan.js';

/**
 * Applies a plan to a state, as the store's transaction would (allocation first, then unit,
 * 11.2). Pure reference implementation, used by the tests and by the store as a model.
 */
export function applyPlan(state: SyncState, plan: SyncPlan, now: Millis): SyncState {
  const units = new Map<string, Unit>(state.units.map((u) => [u.id, u]));
  for (const t of plan.unitTransitions) {
    const u = units.get(t.unitId);
    if (!u || u.status !== t.from) throw new Error(`transition ${t.from}→${t.to} does not apply to unit ${t.unitId}`);
    units.set(u.id, { ...u, status: t.to, locationId: t.locationId, version: u.version + 1 });
  }

  const allocations = new Map<string, Allocation>(state.allocations.map((a) => [a.id, a]));
  for (const up of plan.allocationUpdates) {
    const a = allocations.get(up.id);
    if (!a) throw new Error(`unknown allocation ${up.id}`);
    allocations.set(a.id, { ...a, ...up.patch } as Allocation);
  }
  for (const a of plan.allocationsToCreate) {
    if (allocations.has(a.id)) throw new Error(`duplicate allocation ${a.id}`);
    allocations.set(a.id, a);
  }

  const resolved = new Set(plan.anomaliesToResolve);
  const updated = new Map(plan.anomaliesToUpdate.map((u) => [u.id, u.details]));
  const anomalies: Anomaly[] = state.anomalies.map((a) => {
    if (resolved.has(a.id)) return { ...a, status: 'auto_resolved', resolvedAt: now };
    const details = updated.get(a.id);
    return details ? { ...a, details } : a;
  });
  for (const d of plan.anomaliesToOpen) {
    anomalies.push({ ...d, status: 'open', detectedAt: now, resolvedAt: null });
  }

  return { ...state, units: [...units.values()], allocations: [...allocations.values()], anomalies };
}
