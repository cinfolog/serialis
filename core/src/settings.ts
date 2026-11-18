/**
 * Settings catalogue — spec 6.6. Single source (6.6.1): key, type, allowed values, default,
 * allowed scopes, change rule, warnings and, for each non-default value, the test that proves
 * its behaviour (T-SET-08). This file covers the MVP subset (19.4) plus S-01 and S-24, which
 * are fixed in the MVP. A setting absent from this catalogue does not exist.
 */

export type ScopeType = 'shop' | 'location' | 'tracked_item' | 'identifier_type';
export type ChangeRule = 'immediate' | 'simulation' | 'activation_only';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface NotificationSettings {
  /** `owner` = the shop owner only; otherwise explicit merchant recipients (never customer data). */
  readonly recipients: 'owner' | readonly string[];
  readonly outgoingWebhook: boolean;
  readonly dailyDigest: boolean;
}

export interface IdentifierNormalization {
  readonly stripSpaces: boolean;
  readonly normalizeUpper: boolean;
}

/** Value type of each setting. */
export interface SettingValues {
  'S-01': 'hold' | 'do_not_block';
  'S-05': 'fifo' | 'fefo' | 'manual';
  'S-08': 'last' | 'first';
  'S-09': 'manual' | 'auto';
  'S-11': 'ignore' | 'process';
  'S-17': boolean;
  'S-22': number;
  'S-24': 'do_not_block' | 'hold';
  'S-25': 'auto' | 'on_decision';
  'S-35': 'shop' | 'product';
  'S-36': IdentifierNormalization;
  'S-37': 'none' | 'luhn' | 'regex';
  'S-38': boolean;
  'S-40': NotificationSettings;
}

export type SettingKey = keyof SettingValues;

interface Label {
  readonly fr: string;
  readonly en: string;
}

interface BaseDefinition<K extends SettingKey> {
  readonly key: K;
  readonly label: Label;
  readonly default: SettingValues[K];
  readonly scopes: readonly ScopeType[];
  readonly changeRule: ChangeRule;
  /** Value imposed in the MVP (19.4); the setting is neither shown nor storable. */
  readonly fixedInMvp?: SettingValues[K];
  /** Values that weaken a guarantee, with the warning shown before saving (6.6.1). */
  readonly warning?: { readonly values: readonly string[]; readonly text: Label };
  /**
   * Test proving the behaviour of each non-default value (T-SET-08). Keys: the value as a
   * string for enums and booleans, `other` for durations, `custom` for structured values.
   * Value: the test name, in `core/test` by default, or `<path from the repository root>::<name>`
   * for a test of another suite (e.g. `workers/test/…`).
   */
  readonly testRefs: Readonly<Record<string, string>>;
}

export type SettingDefinition<K extends SettingKey = SettingKey> = BaseDefinition<K> &
  (
    | { readonly kind: 'enum'; readonly values: readonly SettingValues[K][] }
    | { readonly kind: 'boolean' }
    | { readonly kind: 'duration'; readonly min: number; readonly max: number }
    | { readonly kind: 'object'; readonly validate: (value: unknown) => boolean }
  );

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

function isNotificationSettings(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const recipientsOk =
    o.recipients === 'owner' ||
    (Array.isArray(o.recipients) &&
      o.recipients.length > 0 &&
      o.recipients.length <= 10 &&
      o.recipients.every((r) => typeof r === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r)));
  return recipientsOk && isBool(o.outgoingWebhook) && isBool(o.dailyDigest) && Object.keys(o).length === 3;
}

function isNormalization(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return isBool(o.stripSpaces) && isBool(o.normalizeUpper) && Object.keys(o).length === 2;
}

type Catalogue = { readonly [K in SettingKey]: SettingDefinition<K> };

export const SETTINGS: Catalogue = {
  'S-01': {
    key: 'S-01',
    label: { fr: "Commande dont une ligne suivie n'a pas d'unité", en: 'Order with a tracked line without a unit' },
    kind: 'enum',
    values: ['hold', 'do_not_block'],
    default: 'hold',
    scopes: ['shop', 'location', 'tracked_item'],
    changeRule: 'simulation',
    fixedInMvp: 'do_not_block',
    warning: {
      values: ['do_not_block'],
      text: { fr: 'G3 devient une garantie de détection seulement.', en: 'G3 becomes a detection-only guarantee.' },
    },
    testRefs: {},
  },
  'S-05': {
    key: 'S-05',
    label: { fr: 'Unité proposée en premier', en: 'Unit proposed first' },
    kind: 'enum',
    values: ['fifo', 'fefo', 'manual'],
    default: 'fifo',
    scopes: ['shop', 'tracked_item'],
    changeRule: 'immediate',
    testRefs: {
      fefo: 'S-05 fefo: the earliest warranty or expiry end is allocated first',
      manual: 'S-05 manual: no automatic allocation, awaiting_unit opened',
    },
  },
  'S-08': {
    key: 'S-08',
    label: { fr: 'Unités libérées quand une quantité baisse', en: 'Units released when a quantity decreases' },
    kind: 'enum',
    values: ['last', 'first'],
    default: 'last',
    scopes: ['shop'],
    changeRule: 'immediate',
    testRefs: { first: 'S-08 first: a quantity reduction releases the first allocated unit' },
  },
  'S-09': {
    key: 'S-09',
    label: {
      fr: 'Ligne retirée ou annulée sans information de remise en stock',
      en: 'Line removed or cancelled without restock information',
    },
    kind: 'enum',
    values: ['manual', 'auto'],
    default: 'manual',
    scopes: ['shop'],
    changeRule: 'simulation',
    warning: {
      values: ['auto'],
      text: {
        fr: 'Peut consommer un ajout manuel sans rapport fait dans Shopify.',
        en: 'May consume an unrelated manual addition made in Shopify.',
      },
    },
    testRefs: { auto: 'S-09 auto: to-verify units resolved oldest first within the usable deficit' },
  },
  'S-11': {
    key: 'S-11',
    label: { fr: 'Commandes de test', en: 'Test orders' },
    kind: 'enum',
    values: ['ignore', 'process'],
    default: 'ignore',
    scopes: ['shop'],
    changeRule: 'simulation',
    testRefs: { process: 'S-11 process: test orders are allocated like the others' },
  },
  'S-17': {
    key: 'S-17',
    label: { fr: "Contrôle du numéro à la réception d'un retour", en: 'Serial check when a return is received' },
    kind: 'boolean',
    default: true,
    scopes: ['shop'],
    changeRule: 'simulation',
    warning: {
      values: ['false'],
      text: {
        fr: "Une unité mal désignée au retour n'est plus détectable par l'app.",
        en: 'A wrongly designated returned unit can no longer be detected.',
      },
    },
    testRefs: { false: 'S-17 no: a single-unit return line applies its disposition without a typed ref' },
  },
  'S-22': {
    key: 'S-22',
    label: { fr: "Délai de grâce avant qu'un écart devienne une anomalie", en: 'Grace period before a gap becomes an anomaly' },
    kind: 'duration',
    min: 5 * MINUTE,
    max: 24 * HOUR,
    default: 10 * MINUTE,
    scopes: ['shop', 'location'],
    changeRule: 'immediate',
    warning: {
      values: ['above_10_min'],
      text: { fr: "G4 s'allonge d'autant.", en: 'G4 is extended accordingly.' },
    },
    testRefs: { other: 'S-22: a duration set on the shop applies, within 5 min and 24 h' },
  },
  'S-24': {
    key: 'S-24',
    label: {
      fr: 'Activation du suivi sur un article qui a des commandes ouvertes',
      en: 'Tracking activated on an item with open orders',
    },
    kind: 'enum',
    values: ['do_not_block', 'hold'],
    default: 'do_not_block',
    scopes: ['tracked_item'],
    changeRule: 'activation_only',
    fixedInMvp: 'do_not_block',
    testRefs: {},
  },
  'S-25': {
    key: 'S-25',
    label: { fr: "Fin de la phase d'initialisation", en: 'End of the initialization phase' },
    kind: 'enum',
    values: ['auto', 'on_decision'],
    default: 'auto',
    scopes: ['shop', 'tracked_item'],
    changeRule: 'immediate',
    warning: {
      values: ['on_decision'],
      text: {
        fr: 'Les écarts restent affichés « à enregistrer » sans anomalie tant que la phase n’est pas close.',
        en: 'Gaps stay shown as “to register” without anomaly until the phase is closed.',
      },
    },
    testRefs: { on_decision: 'S-25 on decision: the initialization phase ends only on the merchant decision' },
  },
  'S-35': {
    key: 'S-35',
    label: { fr: "Portée de l'unicité", en: 'Uniqueness scope' },
    kind: 'enum',
    values: ['shop', 'product'],
    default: 'shop',
    scopes: ['identifier_type'],
    changeRule: 'simulation',
    testRefs: { product: 'S-35 product: identifier uniqueness scoped by product' },
  },
  'S-36': {
    key: 'S-36',
    label: { fr: 'Normalisation', en: 'Normalization' },
    kind: 'object',
    validate: isNormalization,
    default: { stripSpaces: true, normalizeUpper: true },
    scopes: ['identifier_type'],
    changeRule: 'simulation',
    testRefs: { custom: 'S-36: spaces and case normalization can be turned off independently' },
  },
  'S-37': {
    key: 'S-37',
    label: { fr: 'Validation', en: 'Validation' },
    kind: 'enum',
    values: ['none', 'luhn', 'regex'],
    default: 'none',
    scopes: ['identifier_type'],
    changeRule: 'immediate',
    testRefs: {
      luhn: 'S-37 luhn: IMEI-like identifiers are checked with Luhn',
      regex: 'S-37 regex: identifiers must match the custom expression',
    },
  },
  'S-38': {
    key: 'S-38',
    label: { fr: 'Copie des numéros dans un metafield de commande', en: 'Copy of the refs into an order metafield' },
    kind: 'boolean',
    default: true,
    scopes: ['shop'],
    changeRule: 'simulation',
    // Spec example of T-SET-08: removed from the open orders (Worker chain: API, sync, outbox).
    testRefs: { false: 'workers/test/settings-behaviour.test.ts::S-38 no: the metafield is removed from the open orders at once' },
  },
  'S-40': {
    key: 'S-40',
    label: { fr: 'Notifications', en: 'Notifications' },
    kind: 'object',
    validate: isNotificationSettings,
    default: { recipients: 'owner', outgoingWebhook: false, dailyDigest: true },
    scopes: ['shop'],
    changeRule: 'immediate',
    testRefs: { custom: 'S-40: custom notification settings are accepted and validated' },
  },
};

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

/** Per-identifier-type default of S-37: Luhn for the IMEI type (6.6.2). */
export function identifierTypeDefault<K extends SettingKey>(key: K, identifierType: string | undefined): SettingValues[K] {
  if (key === 'S-37' && identifierType === 'imei') return 'luhn' as SettingValues[K];
  return SETTINGS[key].default as SettingValues[K];
}

export function isValidSettingValue(key: SettingKey, value: unknown): boolean {
  const def = SETTINGS[key] as SettingDefinition;
  switch (def.kind) {
    case 'enum':
      return (def.values as readonly unknown[]).includes(value);
    case 'boolean':
      return isBool(value);
    case 'duration':
      return typeof value === 'number' && Number.isInteger(value) && value >= def.min && value <= def.max;
    case 'object':
      return def.validate(value);
  }
}

/** One stored value (`settings` table, or the columns listed in 11.2). */
export interface StoredSetting {
  readonly scopeType: ScopeType;
  /** Empty for the shop. */
  readonly scopeId: string;
  readonly key: SettingKey;
  readonly value: unknown;
}

export type SettingValidation =
  | { ok: true }
  | { ok: false; error: 'unknown_key' | 'scope_not_allowed' | 'invalid_value' | 'fixed_in_mvp' };

/** Validation of a value before saving (T-SET-01: the API answers 422 on failure). */
export function validateStoredSetting(s: { scopeType: ScopeType; scopeId: string; key: string; value: unknown }): SettingValidation {
  if (!isSettingKey(s.key)) return { ok: false, error: 'unknown_key' };
  const def = SETTINGS[s.key] as SettingDefinition;
  if (def.fixedInMvp !== undefined) return { ok: false, error: 'fixed_in_mvp' };
  if (!def.scopes.includes(s.scopeType)) return { ok: false, error: 'scope_not_allowed' };
  if ((s.scopeType === 'shop') !== (s.scopeId === '')) return { ok: false, error: 'scope_not_allowed' };
  if (!isValidSettingValue(s.key, s.value)) return { ok: false, error: 'invalid_value' };
  return { ok: true };
}

export interface SettingContext {
  readonly trackedItemId?: string;
  readonly locationId?: string;
  readonly identifierType?: string;
  /** Location whose stock is written by an external system (S-23, 6.7). */
  readonly externallyManagedLocation?: boolean;
}

const RESOLUTION_ORDER: readonly ScopeType[] = ['identifier_type', 'tracked_item', 'location', 'shop'];

function scopeIdFor(scope: ScopeType, ctx: SettingContext): string | undefined {
  switch (scope) {
    case 'identifier_type':
      return ctx.identifierType;
    case 'tracked_item':
      return ctx.trackedItemId;
    case 'location':
      return ctx.locationId;
    case 'shop':
      return '';
  }
}

function storedValue(key: SettingKey, scope: ScopeType, scopeId: string | undefined, stored: readonly StoredSetting[]): unknown {
  if (scopeId === undefined) return undefined;
  const hit = stored.find((s) => s.key === key && s.scopeType === scope && s.scopeId === scopeId);
  return hit && isValidSettingValue(key, hit.value) ? hit.value : undefined;
}

/**
 * Applied value (6.6.1): tracked item, then location, then shop, then default; values stored
 * on a scope the catalogue does not allow, or invalid, are ignored. Values fixed in the MVP
 * always win. On an externally managed location, S-22 is 2 h unless set on that location.
 */
export function resolveSetting<K extends SettingKey>(key: K, ctx: SettingContext, stored: readonly StoredSetting[]): SettingValues[K] {
  const def = SETTINGS[key] as SettingDefinition<K>;
  if (def.fixedInMvp !== undefined) return def.fixedInMvp;
  if (key === 'S-22' && ctx.externallyManagedLocation) {
    const onLocation = storedValue(key, 'location', ctx.locationId, stored);
    return (onLocation ?? 2 * HOUR) as SettingValues[K];
  }
  for (const scope of RESOLUTION_ORDER) {
    if (!def.scopes.includes(scope)) continue;
    const v = storedValue(key, scope, scopeIdFor(scope, ctx), stored);
    if (v !== undefined) return v as SettingValues[K];
  }
  return identifierTypeDefault(key, ctx.identifierType);
}

/** Warning to show before saving a value that weakens a guarantee (6.6.1), if any. */
export function settingWarning(key: SettingKey, value: unknown): Label | null {
  const def = SETTINGS[key] as SettingDefinition;
  if (!def.warning) return null;
  const token = key === 'S-22' ? (typeof value === 'number' && value > 10 * MINUTE ? 'above_10_min' : '') : String(value);
  return def.warning.values.includes(token) ? def.warning.text : null;
}
