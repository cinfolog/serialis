/**
 * In-memory implementation of `ApiClient` with realistic French fixtures (no real company or
 * customer names). Selected by `VITE_API_MOCK=1` (`pnpm dev`) and used by the tests.
 *
 * It mimics the server rules the screens rely on: refs normalised (spaces removed, upper case, S-36
 * defaults), uniqueness per shop, "already counted" limited to the Shopify gap, idempotent POSTs
 * (same key = same answer, never applied twice), simulation id required for "simulation" settings.
 */
import type {
  Anomaly,
  CheckUnitsBatchResponse,
  CreateImportRequest,
  CreateUnitsBatchRequest,
  CreateUnitsBatchResponse,
  ErrorCode,
  ExtensionKey,
  HomeStatsResponse,
  ListUnitsQuery,
  Location,
  LookupResponse,
  Page,
  PatchSettingsRequest,
  ResolveAnomalyRequest,
  SettingScope,
  SettingsResponse,
  SettingsSimulation,
  SettingValue,
  SimulateSettingsRequest,
  TrackedItem,
  TrackItemsRequest,
  Unit,
  UnitEvent,
  UnitState,
} from '@serialis/contract';
import type { PickedVariant } from '../shopify';
import {
  ApiError,
  type ApiClient,
  type ImportReportFull,
  type ListAnomaliesQuery,
  type Me,
  type PageParams,
  type WriteOptions,
} from './client';

export const MOCK_LOCATIONS: Location[] = [
  { id: 'loc-bordeaux', name: 'Entrepôt Bordeaux', active: true },
  { id: 'loc-lyon', name: 'Boutique Lyon', active: true },
];

const V_UR500_M = 'gid://shopify/ProductVariant/1001';
const V_UR500_L = 'gid://shopify/ProductVariant/1002';
const V_GR300_54 = 'gid://shopify/ProductVariant/2001';

/** Variants that can be picked in the wizard / "Articles suivis" (not tracked at the start). */
export const MOCK_CANDIDATES: PickedVariant[] = [
  { variantGid: 'gid://shopify/ProductVariant/3001', productGid: 'gid://shopify/Product/300', title: 'Trottinette électrique TE80', variantTitle: 'Noire', sku: 'TE80-NOIR' },
  { variantGid: 'gid://shopify/ProductVariant/4001', productGid: 'gid://shopify/Product/400', title: 'VTT électrique VE700', variantTitle: 'L', sku: 'VE700-L' },
];

export type MockSettingDefaults = Record<string, string | number | boolean>;

export const MOCK_SETTING_DEFAULTS: MockSettingDefaults = {
  'S-05': 'fifo',
  'S-08': 'last',
  'S-09': 'to_verify',
  'S-11': 'ignore',
  'S-17': true,
  'S-22': 10,
  'S-25': 'automatic',
  'S-35': 'shop',
  'S-36.strip_spaces': true,
  'S-36.normalize_upper': true,
  'S-37': 'none',
  'S-38': true,
  'S-40': 'owner_digest',
};

const SIMULATED_KEYS = new Set(['S-09', 'S-11', 'S-17', 'S-35', 'S-36.strip_spaces', 'S-36.normalize_upper', 'S-38']);

export interface MockOptions {
  /** Artificial latency in ms (dev: 120, tests: 0). */
  delayMs?: number;
  locale?: 'fr' | 'en';
  role?: 'admin' | 'operator';
  /** Start from an empty shop (no tracked item), for the empty and wizard states. */
  empty?: boolean;
  /** Start with every extension already displayed. */
  extensionsShown?: boolean;
  now?: () => Date;
}

const FIXED_NOW = new Date('2026-11-17T09:30:00.000Z');
const normalize = (ref: string) => ref.replace(/\s+/g, '').toUpperCase();

export class MockClient implements ApiClient {
  readonly locations = MOCK_LOCATIONS.map((l) => ({ ...l }));
  trackedItems: TrackedItem[] = [];
  units: Unit[] = [];
  anomalies: Anomaly[] = [];
  events = new Map<string, UnitEvent[]>();
  settings: Record<string, string | number | boolean> = { ...MOCK_SETTING_DEFAULTS };
  settingsMeta = new Map<string, { origin: SettingValue['origin']; by: string }>();
  emergencyStop = false;
  extensions: Record<ExtensionKey, boolean>;
  imports = new Map<string, { report: ImportReportFull; units: Array<{ ref: string; variantGid: string; locationId: string; alreadyCounted: boolean }> }>();
  /** Every POST received with its key (lets tests assert that a replay is not applied twice). */
  readonly postLog: Array<{ name: string; key: string }> = [];
  private replay = new Map<string, unknown>();
  private simulations = new Map<string, SimulateSettingsRequest>();
  private seq = 1;

  constructor(readonly options: MockOptions = {}) {
    this.extensions = {
      variant_block: options.extensionsShown ?? false,
      product_block: options.extensionsShown ?? false,
      order_block: options.extensionsShown ?? false,
      order_action: options.extensionsShown ?? false,
    };
    if (!options.empty) this.seed();
  }

  private now(): Date {
    return this.options.now?.() ?? FIXED_NOW;
  }
  private iso(minutesAgo = 0): string {
    return new Date(this.now().getTime() - minutesAgo * 60_000).toISOString();
  }
  private async tick(): Promise<void> {
    const ms = this.options.delayMs ?? 0;
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    else await Promise.resolve();
  }
  private id(prefix: string): string {
    return `${prefix}-${this.seq++}`;
  }

  /** Test helper: an extension reports its first render (T-UX-08). */
  markExtensionShown(key: ExtensionKey): void {
    this.extensions[key] = true;
  }

  // -- fixtures --------------------------------------------------------------

  private makeUnit(ref: string, variantGid: string, locationId: string | null, state: UnitState, extra: Partial<Unit> = {}): Unit {
    const id = this.id('unit');
    const unit: Unit = {
      id,
      variantGid,
      locationId,
      state,
      identifiers: [{ id: `${id}-i1`, type: 'serial', value: ref, primary: true }],
      ref,
      receivedAt: this.iso(60 * 24 * 12),
      orderGid: null,
      version: 1,
      createdAt: this.iso(60 * 24 * 12),
      updatedAt: this.iso(90),
      ...extra,
    };
    this.units.push(unit);
    this.events.set(id, [
      { id: `${id}-e1`, at: unit.createdAt, actor: 'Camille', type: 'unit.received', fromState: null, toState: 'AVAILABLE', reason: 'Réception', stockEffect: '+1 en stock' },
      ...(state !== 'AVAILABLE'
        ? [{ id: `${id}-e2`, at: unit.updatedAt, actor: 'système', type: 'unit.status_changed', fromState: 'AVAILABLE' as UnitState, toState: state, reason: 'Changement d’état', stockEffect: 'aucune écriture' }]
        : []),
    ]);
    return unit;
  }

  private seed(): void {
    this.trackedItems = [
      {
        variantGid: V_UR500_M, productGid: 'gid://shopify/Product/100', title: 'Vélo urbain UR500', variantTitle: 'M', sku: 'UR500-M',
        mode: 'interchangeable', initializing: false, activatedAt: this.iso(60 * 24 * 40),
        stock: [
          { locationId: 'loc-bordeaux', shopifyOnHand: 8, registeredUnits: 8, availableUnits: 6 },
          { locationId: 'loc-lyon', shopifyOnHand: 3, registeredUnits: 3, availableUnits: 3 },
        ],
      },
      {
        variantGid: V_UR500_L, productGid: 'gid://shopify/Product/100', title: 'Vélo urbain UR500', variantTitle: 'L', sku: 'UR500-L',
        mode: 'interchangeable', initializing: false, activatedAt: this.iso(60 * 24 * 40),
        stock: [{ locationId: 'loc-bordeaux', shopifyOnHand: 5, registeredUnits: 5, availableUnits: 4 }],
      },
      {
        variantGid: V_GR300_54, productGid: 'gid://shopify/Product/200', title: 'Vélo gravel GR300', variantTitle: '54',
        sku: 'GR300-54', mode: 'interchangeable', initializing: true, activatedAt: this.iso(60 * 24 * 2),
        stock: [{ locationId: 'loc-bordeaux', shopifyOnHand: 6, registeredUnits: 4, availableUnits: 4 }],
      },
    ];
    for (let i = 0; i < 8; i++) {
      const state: UnitState = i < 6 ? 'AVAILABLE' : i === 6 ? 'ALLOCATED' : 'DAMAGED';
      this.makeUnit(`SN-UR500-M-${51200 + i}`, V_UR500_M, 'loc-bordeaux', state, state === 'ALLOCATED' ? { orderGid: 'gid://shopify/Order/5550101' } : {});
    }
    for (let i = 0; i < 3; i++) this.makeUnit(`SN-UR500-M-${51300 + i}`, V_UR500_M, 'loc-lyon', 'AVAILABLE');
    for (let i = 0; i < 5; i++) this.makeUnit(`SN-UR500-L-${61200 + i}`, V_UR500_L, 'loc-bordeaux', i === 4 ? 'SHIPPED' : 'AVAILABLE', i === 4 ? { orderGid: 'gid://shopify/Order/5550102' } : {});
    for (let i = 0; i < 4; i++) this.makeUnit(`SN-GR300-54-${71200 + i}`, V_GR300_54, 'loc-bordeaux', 'AVAILABLE');

    this.anomalies = [
      {
        id: 'ano-1', type: 'insufficient_units', severity: 'critical', status: 'open', orderGid: 'gid://shopify/Order/5550103', variantGid: V_UR500_L,
        unitId: null, locationId: 'loc-bordeaux', summary: 'Commande #1042 : 2 vélos UR500 L attendus, 1 seule unité disponible à Entrepôt Bordeaux.',
        actions: [{ action: 'receive_units', label: 'Recevoir des unités', writesStock: true, needsRef: false }],
        openedAt: this.iso(35), resolvedAt: null,
      },
      {
        id: 'ano-2', type: 'shipped_unit_to_confirm', severity: 'warning', status: 'open', orderGid: 'gid://shopify/Order/5550102', variantGid: V_UR500_L,
        unitId: null, locationId: 'loc-bordeaux', summary: 'Commande #1039 expédiée : confirmez l’unité réellement partie.',
        actions: [{ action: 'designate_shipped', label: 'Désigner l’unité expédiée', writesStock: false, needsRef: true }],
        openedAt: this.iso(60 * 5), resolvedAt: null,
      },
      {
        id: 'ano-3', type: 'return_unidentified', severity: 'warning', status: 'open', orderGid: 'gid://shopify/Order/5550104', variantGid: V_UR500_M,
        unitId: null, locationId: 'loc-lyon', summary: 'Retour de la commande #1021 reçu à Boutique Lyon : unité à identifier.',
        actions: [{ action: 'identify_return', label: 'Identifier l’unité retournée', writesStock: false, needsRef: true }],
        openedAt: this.iso(60 * 26), resolvedAt: null,
      },
      {
        id: 'ano-4', type: 'stock_mismatch_missing_units', severity: 'warning', status: 'open', orderGid: null, variantGid: V_GR300_54,
        unitId: null, locationId: 'loc-bordeaux', summary: 'Shopify : 6 · Serialis : 4. Il manque 2 unités enregistrées pour GR300 54.',
        actions: [
          { action: 'register_units', label: 'Enregistrer les unités', writesStock: false, needsRef: false },
          { action: 'correct_shopify', label: 'Corriger le stock dans Shopify', writesStock: true, needsRef: false },
        ],
        openedAt: this.iso(60 * 49), resolvedAt: null,
      },
      {
        id: 'ano-5', type: 'awaiting_unit', severity: 'warning', status: 'open', orderGid: 'gid://shopify/Order/5550105', variantGid: V_UR500_M,
        unitId: null, locationId: 'loc-bordeaux', summary: 'Commande #1044 : une ligne suivie n’a pas encore d’unité attribuée.',
        actions: [{ action: 'assign_unit', label: 'Attribuer une unité', writesStock: false, needsRef: true }],
        openedAt: this.iso(12), resolvedAt: null,
      },
      {
        id: 'ano-6', type: 'variant_limit_near', severity: 'info', status: 'acknowledged', orderGid: null, variantGid: null,
        unitId: null, locationId: null, summary: 'Un produit approche la limite de variantes de Shopify.',
        actions: [], openedAt: this.iso(60 * 24 * 3), resolvedAt: null,
      },
    ];
  }

  // -- helpers ---------------------------------------------------------------

  private idempotent<T>(name: string, key: string | undefined, run: () => T): T {
    const k = key ?? `auto-${this.seq++}`;
    this.postLog.push({ name, key: k });
    const cacheKey = `${name}:${k}`;
    if (this.replay.has(cacheKey)) {
      const cached = this.replay.get(cacheKey);
      if (cached instanceof ApiError) throw cached;
      return cached as T;
    }
    try {
      const result = run();
      this.replay.set(cacheKey, result);
      return result;
    } catch (e) {
      if (e instanceof ApiError) this.replay.set(cacheKey, e);
      throw e;
    }
  }

  private recomputeStock(): void {
    for (const item of this.trackedItems) {
      for (const s of item.stock) {
        const mine = this.units.filter((u) => u.variantGid === item.variantGid && u.locationId === s.locationId);
        s.registeredUnits = mine.length;
        s.availableUnits = mine.filter((u) => u.state === 'AVAILABLE').length;
      }
    }
  }

  private page<T>(items: T[], params: PageParams = {}): Page<T> {
    const limit = Math.min(params.limit ?? 50, 250);
    const start = params.cursor ? Number(params.cursor) : 0;
    const slice = items.slice(start, start + limit);
    return { items: slice, nextCursor: start + limit < items.length ? String(start + limit) : null };
  }

  private gapFor(variantGid: string, locationId: string): number | null {
    const item = this.trackedItems.find((t) => t.variantGid === variantGid);
    const s = item?.stock.find((x) => x.locationId === locationId);
    if (!s) return null;
    return Math.max(0, s.shopifyOnHand - s.registeredUnits);
  }

  private checkRefs(req: CreateUnitsBatchRequest): CheckUnitsBatchResponse {
    const seen = new Set<string>();
    const gapBefore = this.gapFor(req.variantGid, req.locationId);
    let counted = 0;
    const rows: CheckUnitsBatchResponse['rows'] = req.refs.map((raw, index) => {
      const ref = normalize(raw);
      if (!/^[A-Z0-9][A-Z0-9._\-/]{2,39}$/.test(ref)) return { index, ref: raw, status: 'invalid_format', detail: 'Caractères autorisés : lettres, chiffres, . _ - /' };
      if (seen.has(ref)) return { index, ref: raw, status: 'duplicate_in_list' };
      seen.add(ref);
      if (this.units.some((u) => normalize(u.ref) === ref)) return { index, ref: raw, status: 'already_known' };
      if (req.alreadyCounted && gapBefore !== null) {
        counted++;
        if (counted > gapBefore) return { index, ref: raw, status: 'beyond_gap', detail: `Écart restant : ${gapBefore}` };
      }
      return { index, ref: raw, status: 'ready' };
    });
    const ready = rows.filter((r) => r.status === 'ready').length;
    return { rows, ready, stockWrite: req.alreadyCounted ? 0 : ready, gapBefore };
  }

  private addUnits(variantGid: string, locationId: string, refs: string[], alreadyCounted: boolean): Unit[] {
    const created = refs.map((ref) => this.makeUnit(normalize(ref), variantGid, locationId, 'AVAILABLE'));
    const item = this.trackedItems.find((t) => t.variantGid === variantGid);
    const stock = item?.stock.find((s) => s.locationId === locationId);
    if (item && !stock) item.stock.push({ locationId, shopifyOnHand: 0, registeredUnits: 0, availableUnits: 0 });
    const s = item?.stock.find((x) => x.locationId === locationId);
    if (s && !alreadyCounted) s.shopifyOnHand += created.length;
    this.recomputeStock();
    if (item?.initializing && item.stock.every((x) => x.registeredUnits >= x.shopifyOnHand)) item.initializing = false;
    return created;
  }

  // -- ApiClient -------------------------------------------------------------

  async me(): Promise<Me> {
    await this.tick();
    const allShown = Object.values(this.extensions).every(Boolean);
    const tracked = this.trackedItems.length > 0;
    const refsDone = tracked && this.trackedItems.every((t) => t.stock.length === 0 || t.stock.some((s) => s.registeredUnits > 0));
    const step: Me['onboarding']['step'] = !tracked ? 'products' : !refsDone ? 'refs' : !allShown ? 'blocks' : 'done';
    return {
      shop: 'velos-demo.myshopify.com',
      installed: true,
      onboarding: { completed: step === 'done', step },
      emergencyStop: this.emergencyStop,
      locale: this.options.locale ?? 'fr',
      role: this.options.role ?? 'admin',
      banners: [],
      extensionsShown: { ...this.extensions },
    };
  }

  async homeStats(): Promise<HomeStatsResponse> {
    await this.tick();
    const counts = new Map<string, number>();
    for (const u of this.units) {
      if (!u.locationId) continue;
      const k = `${u.locationId}|${u.state}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const open = this.anomalies.filter((a) => a.status !== 'resolved');
    const history = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(this.now().getTime() - (29 - i) * 86_400_000);
      return { date: d.toISOString().slice(0, 10), rate: i % 9 === 4 ? null : 0.985 + ((i * 7) % 15) / 1000 };
    });
    return {
      sync: { level: 'green', lastWebhookAt: this.iso(2), lastReconciliationAt: this.iso(7), delaySeconds: 0, pendingWrites: 0 },
      toDo: {
        linesWithoutUnit: open.filter((a) => a.type === 'awaiting_unit' || a.type === 'insufficient_units').length,
        criticalAnomalies: open.filter((a) => a.severity === 'critical').length,
        returnsToIdentify: open.filter((a) => a.type === 'return_unidentified').length,
        shippedUnitsToDesignate: open.filter((a) => a.type === 'shipped_unit_to_confirm').length,
      },
      unitsByState: [...counts.entries()].map(([k, count]) => {
        const [locationId, state] = k.split('|') as [string, UnitState];
        return { locationId, state, count };
      }),
      assignedUnder60s: { rate: 0.991, sample: 214, history30d: history },
    };
  }

  async listTrackedItems(params: PageParams = {}): Promise<Page<TrackedItem>> {
    await this.tick();
    this.recomputeStock();
    return this.page(this.trackedItems.map((t) => structuredClone(t)), params);
  }

  async trackItems(req: TrackItemsRequest, opts: WriteOptions = {}): Promise<Page<TrackedItem>> {
    await this.tick();
    return this.idempotent('trackItems', opts.idempotencyKey, () => {
      const added: TrackedItem[] = [];
      for (const gid of req.variantGids) {
        if (this.trackedItems.some((t) => t.variantGid === gid)) continue;
        const cand = MOCK_CANDIDATES.find((c) => c.variantGid === gid);
        if (!cand) throw new ApiError({ status: 422, code: 'validation_failed', detail: `Variante inconnue : ${gid}` });
        const item: TrackedItem = {
          variantGid: cand.variantGid, productGid: cand.productGid, title: cand.title, variantTitle: cand.variantTitle, sku: cand.sku,
          mode: 'interchangeable', initializing: true, activatedAt: this.iso(),
          stock: [{ locationId: 'loc-bordeaux', shopifyOnHand: 5, registeredUnits: 0, availableUnits: 0 }],
        };
        this.trackedItems.push(item);
        added.push(structuredClone(item));
      }
      return { items: added, nextCursor: null };
    });
  }

  async listUnits(query: ListUnitsQuery = {}): Promise<Page<Unit>> {
    await this.tick();
    const states = query.state === undefined ? null : Array.isArray(query.state) ? query.state : [query.state];
    const q = query.q ? normalize(query.q) : null;
    const items = this.units
      .filter((u) => (query.variant ? u.variantGid === query.variant : true))
      .filter((u) => (query.location ? u.locationId === query.location : true))
      .filter((u) => (states ? states.includes(u.state) : true))
      .filter((u) => (q ? normalize(u.ref).includes(q) : true))
      .map((u) => structuredClone(u));
    return this.page(items, query);
  }

  async getUnit(id: string): Promise<Unit> {
    await this.tick();
    const u = this.units.find((x) => x.id === id);
    if (!u) throw new ApiError({ status: 404, code: 'not_found', detail: 'Unité introuvable.' });
    return structuredClone(u);
  }

  async unitEvents(id: string, params: PageParams = {}): Promise<Page<UnitEvent>> {
    await this.tick();
    if (!this.units.some((x) => x.id === id)) throw new ApiError({ status: 404, code: 'not_found' });
    return this.page([...(this.events.get(id) ?? [])].reverse(), params);
  }

  async lookup(identifier: string): Promise<LookupResponse> {
    await this.tick();
    const q = normalize(identifier);
    const u = this.units.find((x) => x.identifiers.some((i) => normalize(i.value) === q));
    return { unit: u ? structuredClone(u) : null };
  }

  async checkUnitsBatch(req: CreateUnitsBatchRequest, opts: WriteOptions = {}): Promise<CheckUnitsBatchResponse> {
    await this.tick();
    return this.idempotent('checkUnitsBatch', opts.idempotencyKey, () => {
      this.requireTracked(req.variantGid, req.locationId);
      return this.checkRefs(req);
    });
  }

  private requireTracked(variantGid: string, locationId: string): void {
    if (!this.trackedItems.some((t) => t.variantGid === variantGid)) throw new ApiError({ status: 422, code: 'not_tracked', detail: 'Cet article n’est pas suivi.' });
    if (!this.locations.some((l) => l.id === locationId)) throw new ApiError({ status: 422, code: 'validation_failed', detail: 'Emplacement inconnu.' });
  }

  async createUnitsBatch(req: CreateUnitsBatchRequest, opts: WriteOptions = {}): Promise<CreateUnitsBatchResponse> {
    await this.tick();
    return this.idempotent('createUnitsBatch', opts.idempotencyKey, () => {
      this.requireTracked(req.variantGid, req.locationId);
      const check = this.checkRefs(req);
      const bad = check.rows.filter((r) => r.status !== 'ready');
      const rejected = bad.map((r) => ({
        index: r.index,
        ref: r.ref,
        code: (r.status === 'invalid_format' ? 'validation_failed' : r.status === 'beyond_gap' ? 'validation_failed' : 'identifier_conflict') as ErrorCode,
        ...(r.detail ? { detail: r.detail } : {}),
      }));
      if (req.mode === 'atomic' && bad.length > 0) {
        throw new ApiError({ status: 422, code: 'validation_failed', detail: 'Au moins une ref est refusée ; rien n’a été créé.', errors: rejected });
      }
      const good = check.rows.filter((r) => r.status === 'ready').map((r) => r.ref);
      const created = this.addUnits(req.variantGid, req.locationId, good, req.alreadyCounted);
      return { created, rejected };
    });
  }

  async listAnomalies(query: ListAnomaliesQuery = {}): Promise<Page<Anomaly>> {
    await this.tick();
    const items = this.anomalies
      .filter((a) => (query.status ? a.status === query.status : true))
      .filter((a) => (query.severity ? a.severity === query.severity : true))
      .filter((a) => (query.type ? a.type === query.type : true))
      .map((a) => structuredClone(a));
    return this.page(items, query);
  }

  private findAnomaly(id: string): Anomaly {
    const a = this.anomalies.find((x) => x.id === id);
    if (!a) throw new ApiError({ status: 404, code: 'not_found', detail: 'Anomalie introuvable.' });
    return a;
  }

  async acknowledgeAnomaly(id: string, opts: WriteOptions = {}): Promise<Anomaly> {
    await this.tick();
    return this.idempotent('acknowledgeAnomaly', opts.idempotencyKey, () => {
      const a = this.findAnomaly(id);
      if (a.status === 'open') a.status = 'acknowledged';
      return structuredClone(a);
    });
  }

  async resolveAnomaly(id: string, req: ResolveAnomalyRequest, opts: WriteOptions = {}): Promise<Anomaly> {
    await this.tick();
    return this.idempotent('resolveAnomaly', opts.idempotencyKey, () => {
      const a = this.findAnomaly(id);
      const action = a.actions.find((x) => x.action === req.action);
      if (!action) throw new ApiError({ status: 422, code: 'validation_failed', detail: 'Cette résolution n’existe pas pour ce type d’anomalie.' });
      if (action.writesStock && this.options.role === 'operator') throw new ApiError({ status: 403, code: 'forbidden', detail: 'Réservé aux administrateurs.' });
      if (action.needsRef) {
        const typed = typeof req.params?.ref === 'string' ? normalize(req.params.ref) : '';
        if (!typed) throw new ApiError({ status: 422, code: 'validation_failed', detail: 'La ref est obligatoire.' });
        const pool = this.units.filter((u) => (!a.variantGid || u.variantGid === a.variantGid) && (!a.locationId || u.locationId === a.locationId));
        const exact = pool.filter((u) => normalize(u.ref) === typed);
        const suffix = typed.length === 4 ? pool.filter((u) => normalize(u.ref).endsWith(typed)) : [];
        const matches = exact.length ? exact : suffix;
        if (matches.length === 0) {
          const other = this.units.find((u) => normalize(u.ref) === typed);
          if (other) throw new ApiError({ status: 422, code: other.variantGid !== a.variantGid ? 'variant_mismatch' : 'location_mismatch', detail: 'Cette unité ne correspond pas à la commande.' });
          throw new ApiError({ status: 422, code: 'unknown_ref', detail: 'Aucune unité avec cette ref.' });
        }
        if (matches.length > 1) throw new ApiError({ status: 422, code: 'ambiguous_ref', detail: 'Plusieurs unités se terminent par ces caractères : saisissez la ref en entier.' });
      }
      a.status = 'resolved';
      a.resolvedAt = this.iso();
      return structuredClone(a);
    });
  }

  async listLocations(): Promise<Page<Location>> {
    await this.tick();
    return { items: this.locations.map((l) => ({ ...l })), nextCursor: null };
  }

  private settingsResponse(scope: SettingScope): SettingsResponse {
    const values: SettingValue[] = [
      { key: 'S-01', value: 'no_block', origin: 'fixed', changeRule: 'immediate' },
      { key: 'S-24', value: 'no_block', origin: 'fixed', changeRule: 'immediate' },
      ...Object.entries(this.settings).map(([key, value]) => ({
        key,
        value,
        origin: (this.settingsMeta.get(key)?.origin ?? 'default') as SettingValue['origin'],
        changeRule: (SIMULATED_KEYS.has(key) ? 'simulation' : 'immediate') as SettingValue['changeRule'],
      })),
    ];
    return { scope, values };
  }

  async getSettings(scope: SettingScope): Promise<SettingsResponse> {
    await this.tick();
    return this.settingsResponse(scope);
  }

  async simulateSettings(req: SimulateSettingsRequest, opts: WriteOptions = {}): Promise<SettingsSimulation> {
    await this.tick();
    return this.idempotent('simulateSettings', opts.idempotencyKey, () => {
      const simulationId = this.id('sim');
      this.simulations.set(simulationId, req);
      const effects = Object.keys(req.values)
        .filter((k) => SIMULATED_KEYS.has(k))
        .map((key) => ({ key, count: key === 'S-17' ? 1 : 4, summary: key === 'S-17' ? '1 retour en attente d’identification sera traité sans saisie de ref.' : '4 objets seront traités autrement à la prochaine synchronisation.' }));
      const warnings: string[] = [];
      if (req.values['S-17'] === false) warnings.push('S-17 = non : une unité mal désignée au retour n’est plus détectable par l’app.');
      if (req.values['S-09'] === 'auto_resolve') warnings.push('S-09 = résolution automatique : peut consommer un ajout manuel sans rapport fait dans Shopify.');
      return { simulationId, expiresAt: new Date(this.now().getTime() + 10 * 60_000).toISOString(), effects, warnings };
    });
  }

  async patchSettings(req: PatchSettingsRequest): Promise<SettingsResponse> {
    await this.tick();
    if (this.options.role === 'operator') throw new ApiError({ status: 403, code: 'forbidden', detail: 'Réservé aux administrateurs.' });
    const needsSim = Object.keys(req.values).filter((k) => SIMULATED_KEYS.has(k) && req.values[k] !== this.settings[k]);
    if (needsSim.length > 0) {
      const sim = req.simulationId ? this.simulations.get(req.simulationId) : undefined;
      if (!sim) throw new ApiError({ status: 422, code: 'simulation_expired', detail: 'Lancez une nouvelle simulation avant d’enregistrer.' });
    }
    for (const [key, value] of Object.entries(req.values)) {
      if (!(key in MOCK_SETTING_DEFAULTS)) throw new ApiError({ status: 422, code: 'validation_failed', detail: `Réglage inconnu : ${key}` });
      this.settings[key] = value;
      if (value === MOCK_SETTING_DEFAULTS[key]) this.settingsMeta.delete(key);
      else this.settingsMeta.set(key, { origin: 'shop', by: 'Camille' });
    }
    return this.settingsResponse(req.scope);
  }

  private parseCsv(csv: string): Array<Record<string, string>> {
    const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
    const header = (lines.shift() ?? '').split(/[;,]/).map((h) => h.trim().toLowerCase());
    return lines.map((line) => {
      const cells = line.split(/[;,]/).map((c) => c.trim());
      return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
    });
  }

  async createImport(req: CreateImportRequest, opts: WriteOptions = {}): Promise<ImportReportFull> {
    await this.tick();
    return this.idempotent('createImport', opts.idempotencyKey, () => {
      const header = (req.csv.split(/\r?\n/)[0] ?? '').toLowerCase();
      if (!header.includes('ref') || !(header.includes('sku') || header.includes('variant_id')) || !header.includes('location')) {
        throw new ApiError({ status: 422, code: 'validation_failed', detail: 'Colonnes attendues : ref, sku (ou variant_id), location, already_counted.' });
      }
      const rows = this.parseCsv(req.csv);
      const errors: ImportReportFull['errors'] = [];
      const ok: Array<{ ref: string; variantGid: string; locationId: string; alreadyCounted: boolean }> = [];
      const seen = new Set<string>();
      const countedPerKey = new Map<string, number>();
      let beyondGap = 0;
      rows.forEach((row, i) => {
        const rowNo = i + 2;
        const ref = normalize(row['ref'] ?? '');
        const item = this.trackedItems.find((t) => (row['sku'] && t.sku === row['sku']) || (row['variant_id'] && t.variantGid.endsWith(`/${row['variant_id']}`)));
        const loc = this.locations.find((l) => l.name === row['location'] || l.id === row['location']);
        const counted = ['1', 'true', 'oui', 'yes'].includes((row['already_counted'] ?? '').toLowerCase());
        if (!ref) return void errors.push({ row: rowNo, code: 'validation_failed', detail: 'ref manquante' });
        if (!item) return void errors.push({ row: rowNo, code: 'not_tracked', detail: `article non suivi : ${row['sku'] || row['variant_id'] || '(vide)'}` });
        if (!loc) return void errors.push({ row: rowNo, code: 'validation_failed', detail: `emplacement inconnu : ${row['location'] ?? ''}` });
        if (seen.has(ref) || this.units.some((u) => normalize(u.ref) === ref)) return void errors.push({ row: rowNo, code: 'identifier_conflict', detail: `ref déjà connue : ${ref}` });
        seen.add(ref);
        if (counted) {
          const key = `${item.variantGid}|${loc.id}`;
          const used = (countedPerKey.get(key) ?? 0) + 1;
          countedPerKey.set(key, used);
          const gap = this.gapFor(item.variantGid, loc.id);
          if (gap !== null && used > gap) {
            beyondGap++;
            return void errors.push({ row: rowNo, code: 'validation_failed', detail: 'au-delà de l’écart avec Shopify' });
          }
        }
        ok.push({ ref, variantGid: item.variantGid, locationId: loc.id, alreadyCounted: counted });
      });
      const report: ImportReportFull = {
        id: this.id('imp'), status: 'simulated', rows: rows.length, valid: ok.length, errors, beyondGap,
        stockWrites: ok.filter((r) => !r.alreadyCounted).length,
      };
      this.imports.set(report.id, { report, units: ok });
      return structuredClone(report);
    });
  }

  async confirmImport(id: string, opts: WriteOptions = {}): Promise<ImportReportFull> {
    await this.tick();
    return this.idempotent('confirmImport', opts.idempotencyKey, () => {
      const entry = this.imports.get(id);
      if (!entry) throw new ApiError({ status: 404, code: 'not_found', detail: 'Import introuvable.' });
      if (entry.report.status === 'simulated') {
        for (const u of entry.units) this.addUnits(u.variantGid, u.locationId, [u.ref], u.alreadyCounted);
        entry.report.status = 'confirmed';
      }
      return structuredClone(entry.report);
    });
  }

  async pause(opts: WriteOptions = {}) {
    await this.tick();
    return this.idempotent('pause', opts.idempotencyKey, () => {
      if (this.options.role === 'operator') throw new ApiError({ status: 403, code: 'forbidden', detail: 'Réservé aux administrateurs.' });
      this.emergencyStop = true;
      return { emergencyStop: true };
    });
  }

  async resume(opts: WriteOptions = {}) {
    await this.tick();
    return this.idempotent('resume', opts.idempotencyKey, () => {
      if (this.options.role === 'operator') throw new ApiError({ status: 403, code: 'forbidden', detail: 'Réservé aux administrateurs.' });
      this.emergencyStop = false;
      return { emergencyStop: false };
    });
  }

  /** Mock-only: what the Shopify resource picker would offer (not yet tracked variants). */
  pickableVariants(): PickedVariant[] {
    return MOCK_CANDIDATES.filter((c) => !this.trackedItems.some((t) => t.variantGid === c.variantGid)).map((c) => ({ ...c }));
  }
}
