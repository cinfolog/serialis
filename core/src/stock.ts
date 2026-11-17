import { COUNTED_STATES } from './states.js';
import type { SettingValues } from './settings.js';
import type { ExplainedQuantity, InventoryLevel, LocationId, StockWriteIntent, TrackedItem, Unit } from './types.js';

/** Stock helpers — spec section 8 (usable deficit and excess) and 8.1 (resolution of a gap). */

export function countedUnits(units: readonly Unit[], trackedItemId: string, locationId: LocationId): number {
  return units.filter((u) => u.trackedItemId === trackedItemId && u.locationId === locationId && COUNTED_STATES.has(u.status)).length;
}

function openExplained(
  explained: readonly ExplainedQuantity[],
  level: InventoryLevel,
  direction: ExplainedQuantity['direction'],
  excludeSourceRef?: string,
): ExplainedQuantity[] {
  return explained.filter(
    (e) =>
      e.status === 'open' &&
      e.direction === direction &&
      e.trackedItemId === level.trackedItemId &&
      e.locationId === level.locationId &&
      e.sourceRef !== excludeSourceRef,
  );
}

/**
 * Usable deficit (8): (on_hand − counted units) − quantities already explained in progress.
 * When resolving a precise cause, the quantity explained by that very cause is excluded.
 */
export function usableDeficit(
  level: InventoryLevel,
  units: readonly Unit[],
  explained: readonly ExplainedQuantity[],
  excludeSourceRef?: string,
): number {
  const raw = level.onHand - countedUnits(units, level.trackedItemId, level.locationId);
  const known = openExplained(explained, level, 'deficit', excludeSourceRef).reduce((s, e) => s + e.quantity, 0);
  return raw - known;
}

/** Usable excess (8): (counted units − on_hand) − open sales without unit and undesignated native shipments. */
export function usableExcess(level: InventoryLevel, units: readonly Unit[], explained: readonly ExplainedQuantity[]): number {
  const raw = countedUnits(units, level.trackedItemId, level.locationId) - level.onHand;
  const known = openExplained(explained, level, 'surplus').reduce((s, e) => s + e.quantity, 0);
  return raw - known;
}

export interface ToVerifyResolution {
  readonly unitId: string;
  readonly from: 'TO_VERIFY';
  readonly to: 'AVAILABLE';
  readonly locationId: LocationId;
  /** Null when Shopify already restocked the quantity (usable deficit > 0). */
  readonly write: StockWriteIntent | null;
}

/**
 * Resolution "put back in stock" of a TO_VERIFY unit (8.1, T-E2E-37): the level is read again
 * in the same task; with a usable deficit the unit becomes AVAILABLE without any write,
 * otherwise the app adds 1 to `available`. A unit can never be put back twice: it is no longer
 * TO_VERIFY afterwards.
 */
export function planToVerifyRestock(
  unit: Unit,
  item: TrackedItem,
  level: InventoryLevel,
  units: readonly Unit[],
  explained: readonly ExplainedQuantity[],
): ToVerifyResolution | null {
  if (unit.status !== 'TO_VERIFY' || unit.locationId === null || unit.locationId !== level.locationId) return null;
  const deficit = usableDeficit(level, units, explained, unit.id);
  return {
    unitId: unit.id,
    from: 'TO_VERIFY',
    to: 'AVAILABLE',
    locationId: unit.locationId,
    write:
      deficit > 0
        ? null
        : {
            kind: 'adjust',
            inventoryItemGid: item.inventoryItemGid,
            locationId: unit.locationId,
            quantityName: 'available',
            delta: 1,
            unitId: unit.id,
            reason: 'to_verify_restock',
          },
  };
}

/**
 * S-09 = auto: TO_VERIFY units resolved without write when the re-read level shows a usable
 * deficit, the oldest first, one unit per unit of deficit. S-09 = manual: nothing automatic.
 */
export function planAutomaticToVerifyResolution(
  setting: SettingValues['S-09'],
  toVerify: readonly { readonly unit: Unit; readonly since: number }[],
  deficit: number,
): string[] {
  if (setting !== 'auto' || deficit <= 0) return [];
  return toVerify
    .filter((t) => t.unit.status === 'TO_VERIFY')
    .slice()
    .sort((a, b) => a.since - b.since || (a.unit.id < b.unit.id ? -1 : 1))
    .slice(0, deficit)
    .map((t) => t.unit.id);
}

/** End of the initialization phase (EF-01, S-25): automatic once I1 holds, or on the merchant decision. */
export function initializationShouldEnd(setting: SettingValues['S-25'], i1Holds: boolean, merchantDecided: boolean): boolean {
  if (merchantDecided) return true;
  return setting === 'auto' && i1Holds;
}
