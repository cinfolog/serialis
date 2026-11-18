import type { AnomalySubject, Severity } from './types.js';

/** Anomaly catalogue — spec 12.7 (severity of the catalogue; S-41 may shift it, not in the MVP). */
export const ANOMALY_CATALOGUE = {
  insufficient_units: 'critical',
  shipped_without_unit: 'critical',
  // Critical in the full product; warning in the MVP (no POS extension, 12.7 and 19.4).
  pos_sold_without_unit: 'warning',
  hold_failed: 'critical',
  stock_mismatch_missing_units: 'warning',
  stock_mismatch_extra_units: 'warning',
  unit_to_verify: 'warning',
  return_unidentified: 'warning',
  inventory_write_conflict: 'warning',
  outbox_dead: 'critical',
  unique_variant_policy_changed: 'critical',
  variant_limit_near: 'info',
  transfer_overdue: 'warning',
  webhook_silence: 'critical',
  preexisting_sale_to_designate: 'warning',
  shipped_unit_to_confirm: 'warning',
  order_out_of_window: 'warning',
  return_unit_mismatch: 'warning',
  unique_product_unpublished: 'warning',
  variant_deleted: 'warning',
  native_shipment_to_designate: 'warning',
  native_receipt_to_designate: 'warning',
  mode_conversion_in_progress: 'info',
  pos_lock_conflict: 'info',
  draft_hold_released: 'info',
  untracked_to_confirm: 'warning',
  storage_high: 'warning',
  hold_released_manually: 'info',
  native_shipment_rejected: 'warning',
  unique_product_left_archived: 'info',
  awaiting_unit: 'warning',
  missing_required_attribute: 'warning',
  inventory_invariant_violation: 'critical',
  reconnect_required: 'critical',
  bulk_operation_slow: 'critical',
  unique_variant_missing: 'warning',
  invalid_serial_property: 'warning',
  tracking_disabled_in_shopify: 'critical',
  units_on_inactive_location: 'warning',
  // Not in the 12.7 table (workers/DECISIONS.md, to report in the spec): 12.2 asks for a critical
  // anomaly when a task reaches `dead`, 11.2 for a detected allocation/unit inconsistency.
  task_dead: 'critical',
  consistency_violation: 'critical',
} as const satisfies Record<string, Severity>;

export type AnomalyType = keyof typeof ANOMALY_CATALOGUE;

export function severityOf(type: AnomalyType): Severity {
  return ANOMALY_CATALOGUE[type];
}

/**
 * Canonical fingerprint key: type and the sorted subject identifiers (11.2). The same cause
 * always yields the same key; the store keeps its SHA-256 (DECISIONS.md, D-07).
 */
export function anomalyFingerprint(type: AnomalyType, subject: AnomalySubject): string {
  const parts = Object.entries(subject)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  return [type, ...parts].join('|');
}
