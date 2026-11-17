import { checkTransition } from '../transitions.js';
import type { UnitState } from '../states.js';
import type { Allocation, AllocationStatus, AnomalyDetails, Gid, LocationId, Unit } from '../types.js';
import type { AllocationUpdate, RejectedTransition, UnitEventType, UnitTransition } from './plan.js';

/**
 * Mutable working copy used while planning: every change is applied to the copy (so later
 * steps see it) and recorded. At the end, allocation changes are folded into creations and
 * minimal patches.
 */
export class Workspace {
  private readonly units = new Map<string, Unit>();
  private readonly allocations = new Map<string, Allocation>();
  private readonly originals = new Map<string, Allocation>();
  private readonly created = new Set<string>();
  readonly transitions: UnitTransition[] = [];
  readonly rejected: RejectedTransition[] = [];

  constructor(units: readonly Unit[], allocations: readonly Allocation[]) {
    for (const u of units) this.units.set(u.id, u);
    for (const a of allocations) {
      this.allocations.set(a.id, a);
      this.originals.set(a.id, a);
    }
  }

  unit(id: string): Unit | undefined {
    return this.units.get(id);
  }

  allUnits(): Unit[] {
    return [...this.units.values()];
  }

  allAllocations(): Allocation[] {
    return [...this.allocations.values()];
  }

  /** Allocations of an order line, optionally filtered by location and status. */
  lineAllocations(orderGid: Gid, lineItemGid: Gid, status?: AllocationStatus, locationId?: LocationId): Allocation[] {
    return this.allAllocations().filter(
      (a) =>
        a.orderGid === orderGid &&
        a.lineItemGid === lineItemGid &&
        (status === undefined || a.status === status) &&
        (locationId === undefined || a.locationId === locationId),
    );
  }

  /** G1: the unit is engaged in an `active` or `fulfilled` allocation. */
  isEngaged(unitId: string): boolean {
    for (const a of this.allocations.values()) {
      if (a.unitId === unitId && (a.status === 'active' || a.status === 'fulfilled')) return true;
    }
    return false;
  }

  createAllocation(a: Allocation): void {
    this.allocations.set(a.id, a);
    this.created.add(a.id);
  }

  patchAllocation(id: string, patch: AllocationUpdate['patch']): Allocation {
    const current = this.allocations.get(id);
    if (!current) throw new Error(`unknown allocation ${id}`);
    const next = { ...current, ...patch } as Allocation;
    this.allocations.set(id, next);
    return next;
  }

  /**
   * Records a unit transition after checking the state pair (`checkTransition`) and the
   * expected current state. Returns false (and records a rejection) when refused.
   */
  transition(
    unitId: string,
    expectedFrom: UnitState,
    to: UnitState,
    event: UnitEventType,
    opts: { allocationId: string | null; locationId?: LocationId | null; data?: AnomalyDetails },
  ): boolean {
    const unit = this.units.get(unitId);
    if (!unit || unit.status !== expectedFrom) {
      this.rejected.push({ unitId, from: unit?.status ?? null, to, reason: 'unexpected_state' });
      return false;
    }
    const check = checkTransition(unit.status, to);
    if (!check.ok) {
      this.rejected.push({ unitId, from: unit.status, to, reason: 'forbidden_transition' });
      return false;
    }
    const locationId = opts.locationId === undefined ? unit.locationId : opts.locationId;
    this.units.set(unitId, { ...unit, status: to, locationId, version: unit.version + 1 });
    this.transitions.push({
      unitId,
      from: unit.status,
      to,
      locationId,
      allocationId: opts.allocationId,
      event,
      guarded: check.guarded,
      data: opts.data ?? {},
    });
    return true;
  }

  createdAllocations(): Allocation[] {
    return [...this.created].map((id) => this.allocations.get(id) as Allocation);
  }

  allocationUpdates(): AllocationUpdate[] {
    const updates: AllocationUpdate[] = [];
    for (const [id, original] of this.originals) {
      const current = this.allocations.get(id) as Allocation;
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(current) as (keyof Allocation)[]) {
        if (current[k] !== original[k]) patch[k] = current[k];
      }
      if (Object.keys(patch).length > 0) {
        patch.allocationVersion = original.allocationVersion + 1;
        updates.push({ id, patch: patch as AllocationUpdate['patch'] });
      }
    }
    return updates;
  }
}
