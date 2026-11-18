/** Mapping of domain rows to the contract types (api/contract). */
import type { Allocation as CoreAllocation, Anomaly as CoreAnomaly } from '@serialis/core';
import type { Allocation, Anomaly, TrackedItem, Unit } from '@serialis/contract';
import type { DomainContext } from '../domain/context.js';
import type { Cause, TrackedItemRow, UnitRecord } from '../domain/repo.js';
import type { ApiCall } from './http.js';
import { iso } from './http.js';

export interface ApiContext {
  d: DomainContext;
  call: ApiCall;
  now: number;
  cause: Cause;
  locale: 'fr' | 'en';
}

export function presentUnit(ctx: ApiContext, u: UnitRecord, current?: CoreAllocation | null): Unit {
  const ids = ctx.d.repo.identifierRows(u.id).filter((i) => !i.retired);
  const alloc = current === undefined ? ctx.d.repo.currentAllocationOf(u.id) : current;
  return {
    id: u.id,
    variantGid: u.variantGid,
    locationId: u.locationId,
    state: u.status,
    identifiers: ids.map((i) => ({ id: i.id, type: i.type, value: i.value, primary: i.primary })),
    ref: u.primaryIdentifier ?? ids[0]?.value ?? '',
    receivedAt: iso(u.receivedAt),
    orderGid: alloc?.orderGid ?? null,
    version: u.version,
    createdAt: new Date(u.createdAt).toISOString(),
    updatedAt: new Date(u.updatedAt).toISOString(),
  };
}

export function presentAllocation(ctx: ApiContext, a: CoreAllocation, ref?: string): Allocation {
  return {
    id: a.id,
    unitId: a.unitId,
    ref: ref ?? ctx.d.repo.unit(a.unitId)?.primaryIdentifier ?? '',
    orderGid: a.orderGid,
    lineItemGid: a.lineItemGid,
    variantGid: a.variantGid,
    locationId: a.locationId,
    status: a.status,
    source: a.source,
    toConfirm: a.toConfirm,
    allocatedAt: new Date(a.allocatedAt).toISOString(),
  };
}

export function presentTrackedItem(ctx: ApiContext, item: TrackedItemRow): TrackedItem {
  const { sql } = ctx.d;
  const levels = new Map(ctx.d.repo.levelsOfItem(item.id).map((l) => [l.locationId, l.onHand]));
  const counts = new Map<string, { registered: number; available: number }>();
  for (const r of sql
    .exec<{ location_id: string; registered: number; available: number }>(
      `SELECT location_id,
         SUM(CASE WHEN status IN ('AVAILABLE', 'HELD', 'ALLOCATED', 'QUALITY_CONTROL', 'DAMAGED') THEN 1 ELSE 0 END) AS registered,
         SUM(CASE WHEN status = 'AVAILABLE' THEN 1 ELSE 0 END) AS available
       FROM units WHERE tracked_item_id = ? AND location_id IS NOT NULL GROUP BY location_id`,
      item.id,
    )
    .toArray()) {
    counts.set(r.location_id, { registered: r.registered, available: r.available });
  }
  const locations = [...new Set([...levels.keys(), ...counts.keys()])].sort();
  return {
    variantGid: item.variantGid,
    productGid: item.productGid,
    title: item.productTitle ?? '',
    variantTitle: item.variantTitle,
    sku: item.sku,
    mode: 'interchangeable',
    initializing: item.initializing,
    activatedAt: new Date(item.activatedAt).toISOString(),
    stock: locations.map((locationId) => ({
      locationId,
      shopifyOnHand: levels.get(locationId) ?? 0,
      registeredUnits: counts.get(locationId)?.registered ?? 0,
      availableUnits: counts.get(locationId)?.available ?? 0,
    })),
  };
}

type Action = Anomaly['actions'][number];

const L = (fr: string, en: string) => ({ fr, en });

const ACTIONS: Record<string, Array<{ action: string; label: { fr: string; en: string }; writesStock: boolean; needsRef: boolean }>> = {
  awaiting_unit: [{ action: 'allocate', label: L('Attribuer une unité', 'Allocate a unit'), writesStock: false, needsRef: true }],
  insufficient_units: [{ action: 'allocate', label: L('Attribuer une unité', 'Allocate a unit'), writesStock: false, needsRef: true }],
  shipped_without_unit: [{ action: 'designate', label: L("Désigner l'unité expédiée", 'Designate the shipped unit'), writesStock: false, needsRef: true }],
  pos_sold_without_unit: [{ action: 'designate', label: L("Désigner l'unité vendue", 'Designate the sold unit'), writesStock: false, needsRef: true }],
  preexisting_sale_to_designate: [{ action: 'designate', label: L("Désigner l'unité partie", 'Designate the unit that left'), writesStock: false, needsRef: true }],
  shipped_unit_to_confirm: [{ action: 'confirm_shipped', label: L('Désigner une unité réellement expédiée', 'Designate a unit really shipped'), writesStock: false, needsRef: true }],
  return_unidentified: [{ action: 'identify', label: L("Identifier l'unité retournée", 'Identify the returned unit'), writesStock: false, needsRef: true }],
  unit_to_verify: [
    { action: 'restock', label: L('Remettre en stock', 'Put back in stock'), writesStock: true, needsRef: false },
    { action: 'lose', label: L('Déclarer perdue', 'Declare lost'), writesStock: false, needsRef: false },
    { action: 'scrap', label: L('Mettre au rebut', 'Scrap'), writesStock: false, needsRef: false },
  ],
  stock_mismatch_missing_units: [{ action: 'recheck', label: L('Revérifier le stock', 'Check the stock again'), writesStock: false, needsRef: false }],
  stock_mismatch_extra_units: [{ action: 'recheck', label: L('Revérifier le stock', 'Check the stock again'), writesStock: false, needsRef: false }],
  inventory_invariant_violation: [{ action: 'recheck', label: L('Revérifier le stock', 'Check the stock again'), writesStock: false, needsRef: false }],
};

const DISMISS = { action: 'dismiss', label: L('Clore', 'Close'), writesStock: false, needsRef: false };

export function anomalyActions(type: string, locale: 'fr' | 'en'): Action[] {
  const list = ACTIONS[type] ?? [];
  const withDismiss = type === 'unit_to_verify' || type === 'awaiting_unit' || type === 'insufficient_units' ? list : [...list, DISMISS];
  return withDismiss.map((a) => ({ action: a.action, label: a.label[locale], writesStock: a.writesStock, needsRef: a.needsRef }));
}

const SUMMARIES: Record<string, { fr: string; en: string }> = {
  awaiting_unit: L('Ligne suivie en attente de {q} unité(s)', 'Tracked line waiting for {q} unit(s)'),
  insufficient_units: L('Unités insuffisantes : {q} manquante(s)', 'Insufficient units: {q} missing'),
  shipped_without_unit: L('Expédiée sans numéro : {q} unité(s)', 'Shipped without ref: {q} unit(s)'),
  pos_sold_without_unit: L('Vendue en caisse sans numéro : {q} unité(s)', 'Sold at the POS without ref: {q} unit(s)'),
  preexisting_sale_to_designate: L('Vente antérieure au suivi à désigner : {q}', 'Sale made before tracking to designate: {q}'),
  shipped_unit_to_confirm: L('Unités expédiées à confirmer : {q}', 'Shipped units to confirm: {q}'),
  return_unidentified: L('Retour à identifier : {q} unité(s)', 'Return to identify: {q} unit(s)'),
  unit_to_verify: L('Unité à vérifier', 'Unit to verify'),
  return_unit_mismatch: L("Unité saisie au retour différente de l'unité vendue", 'Unit typed at return differs from the unit sold'),
  invalid_serial_property: L('Propriété _serialis_units ignorée', 'Property _serialis_units ignored'),
  stock_mismatch_missing_units: L('Stock Shopify supérieur aux unités ({gap})', 'Shopify stock above the units ({gap})'),
  stock_mismatch_extra_units: L('Stock Shopify inférieur aux unités ({gap})', 'Shopify stock below the units ({gap})'),
  inventory_invariant_violation: L('Stock vendable supérieur aux unités disponibles', 'Sellable stock above available units'),
  outbox_dead: L('Écriture Shopify bloquée', 'Shopify write blocked'),
  inventory_write_conflict: L("Conflit d'écriture de stock", 'Inventory write conflict'),
  tracking_disabled_in_shopify: L('Suivi du stock désactivé dans Shopify', 'Inventory tracking disabled in Shopify'),
};

export function presentAnomaly(ctx: ApiContext, a: CoreAnomaly & { resolution?: unknown }): Anomaly {
  const template = SUMMARIES[a.type]?.[ctx.locale] ?? a.type;
  const summary = template.replace('{q}', String(a.details.quantity ?? 1)).replace('{gap}', String(a.details.gap ?? ''));
  return {
    id: a.id,
    type: a.type,
    severity: a.severity,
    status: a.status === 'auto_resolved' ? 'resolved' : a.status,
    orderGid: a.subject.orderGid ?? null,
    variantGid: a.subject.variantGid ?? (typeof a.details.variantGid === 'string' ? a.details.variantGid : null),
    unitId: a.subject.unitId ?? null,
    locationId: a.subject.locationId ?? null,
    summary,
    actions: a.status === 'open' || a.status === 'acknowledged' ? anomalyActions(a.type, ctx.locale) : [],
    openedAt: new Date(a.detectedAt).toISOString(),
    resolvedAt: iso(a.resolvedAt),
  };
}
