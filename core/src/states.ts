/**
 * Unit states — spec section 7.1.
 * "Counted" states are part of the physical stock of a location and map to a Shopify quantity state.
 */
export const UNIT_STATES = [
  'INCOMING',
  'AVAILABLE',
  'HELD',
  'ALLOCATED',
  'QUALITY_CONTROL',
  'DAMAGED',
  'IN_TRANSIT',
  'SHIPPED',
  'RETURN_PENDING',
  'TO_VERIFY',
  'LOST',
  'SCRAPPED',
  'UNTRACKED',
] as const;

export type UnitState = (typeof UNIT_STATES)[number];

/** States counted in the physical stock of a location (a location is mandatory). */
export const COUNTED_STATES: ReadonlySet<UnitState> = new Set<UnitState>([
  'AVAILABLE',
  'HELD',
  'ALLOCATED',
  'QUALITY_CONTROL',
  'DAMAGED',
]);

export type ShopifyQuantityName =
  | 'available'
  | 'reserved'
  | 'committed'
  | 'quality_control'
  | 'damaged';

/**
 * Shopify quantity state that holds a counted unit.
 * HELD depends on how the hold was made (manual hold → reserved, draft order pre-allocation → committed),
 * so it needs the hold flag.
 */
export function shopifyQuantityFor(state: UnitState, holdMovedStock = false): ShopifyQuantityName | null {
  switch (state) {
    case 'AVAILABLE':
      return 'available';
    case 'HELD':
      return holdMovedStock ? 'reserved' : 'committed';
    case 'ALLOCATED':
      return 'committed';
    case 'QUALITY_CONTROL':
      return 'quality_control';
    case 'DAMAGED':
      return 'damaged';
    default:
      return null;
  }
}

export function isUnitState(value: unknown): value is UnitState {
  return typeof value === 'string' && (UNIT_STATES as readonly string[]).includes(value);
}
