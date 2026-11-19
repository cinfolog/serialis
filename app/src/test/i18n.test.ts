import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ERROR_CODES, PROBLEM_DETAIL_KEYS, SETTINGS_SIMULATION_SUMMARIES, STOCK_QUANTITY_NAMES, UNIT_EVENT_REASONS, UNIT_EVENT_TYPES, type ErrorCode } from '@serialis/contract';
import { describe, expect, it } from 'vitest';
import { createI18n, dictionaries } from '../i18n';
import { problemMessage, simulationEffectLabel, unitEventActorLabel, unitEventReasonLabel, unitEventStockLabel, unitEventTypeLabel } from '../labels';
import { placeholderNames, translate } from '../i18n/core';
import { FIXED_SETTINGS, SETTINGS, THEMES } from '../settings/catalogue';

const SRC = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe('Textes fr / en (15.9)', () => {
  it('French and English have exactly the same keys and the same placeholders', () => {
    const fr = dictionaries.fr;
    const en = dictionaries.en;
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
    for (const key of Object.keys(fr)) expect(placeholderNames(en[key] as string), key).toEqual(placeholderNames(fr[key] as string));
  });

  it('French is the default language and plurals follow the language', () => {
    const fr = createI18n('fr');
    const en = createI18n('en');
    expect(fr.t('home.todo.critical', { count: 1 })).toBe('1 anomalie critique');
    expect(fr.t('home.todo.critical', { count: 3 })).toBe('3 anomalies critiques');
    expect(en.t('home.todo.critical', { count: 1 })).toBe('1 critical anomaly');
    expect(en.t('home.todo.critical', { count: 3 })).toBe('3 critical anomalies');
    expect(translate({}, 'fr', 'unknown.key')).toBe('unknown.key');
  });

  it('plural arguments: several counts in one message, each with the plural form of the language (recette 2: « 1 rows »)', () => {
    const fr = createI18n('fr');
    const en = createI18n('en');
    expect(en.t('imports.confirm', { count: 1 })).toBe('Confirm the import of 1 row');
    expect(en.t('imports.confirm', { count: 2 })).toBe('Confirm the import of 2 rows');
    expect(fr.t('imports.confirm', { count: 1 })).toBe('Confirmer l’import de 1 ligne');
    expect(fr.t('imports.confirm', { count: 0 })).toBe('Confirmer l’import de 0 ligne');
    expect(en.t('imports.confirm.body', { count: 1, writes: 1, errors: 1 })).toBe('1 unit will be created. Shopify will receive 1 unit in stock; the others are already counted and cause no write. The row in error is skipped.');
    expect(fr.t('imports.confirm.body', { count: 3, writes: 0, errors: 2 })).toBe('3 unités seront créées. Shopify recevra aucune unité en stock ; les autres sont déjà comptées et ne provoquent aucune écriture. Les 2 lignes en erreur sont ignorées.');
    expect(en.t('imports.report.effect', { writes: 1, counted: 1 })).toBe('Expected stock effect: 1 write in Shopify; the other valid row is already counted (no write).');
    expect(fr.t('imports.done', { count: 1 })).toBe('Import confirmé : 1 unité créée.');
    expect(fr.t('refs.summary', { ready: 1, total: 3 })).toBe('1 prête sur 3. Seules les lignes prêtes seront validées.');
    expect(en.t('refs.effect.counted', { count: 1, location: 'A' })).toBe('Effect: no write in Shopify, this unit is already counted at A.');
    expect(fr.t('tracked.stock.line', { location: 'A', shopify: 1, registered: 1 })).toBe('A : 1 dans Shopify, 1 enregistrée');
    expect(fr.t('imports.confirm', { count: 1200 })).toBe(`Confirmer l’import de ${new Intl.NumberFormat('fr').format(1200)} lignes`);
    expect(placeholderNames('{a} {n, plural, one {# x {b}} other {# y}}')).toEqual(['a', 'b', 'n']);
  });

  it('every count shown is either a plural key or a plural argument (no « {count} rows »)', () => {
    for (const [key, text] of Object.entries(dictionaries.en)) {
      if (/_(one|other)$/.test(key)) continue;
      // A bare number placeholder directly followed by a plural noun is the defect of the recette.
      expect(text, key).not.toMatch(/\{(count|writes|errors|counted|ready|registered)\} (rows|units|writes|lines|refs|orders)\b/);
    }
    for (const [key, text] of Object.entries(dictionaries.fr)) {
      if (/_(one|other)$/.test(key)) continue;
      expect(text, key).not.toMatch(/\{(count|writes|errors|counted|ready|registered)\} (lignes|unités|écritures|refs|commandes|prêtes|enregistrées)\b/);
    }
  });

  it('has a text for every error code of the contract, every setting, theme and fixed setting', () => {
    const codes: readonly ErrorCode[] = ERROR_CODES;
    const keys = [...codes.map((c) => `error.${c}`), ...PROBLEM_DETAIL_KEYS.map((d) => `error.detail.${d}`), 'error.network', 'error.unknown', ...THEMES.map((t) => `settings.theme.${t}`)];
    for (const def of SETTINGS) {
      if (def.kind === 'choice') {
        keys.push(`settings.${def.key}.question`);
        for (const c of def.choices) {
          keys.push(`settings.${def.key}.choice.${c.id}`, `settings.${def.key}.effect.${c.id}`);
          if (c.weakens) keys.push(`settings.${def.key}.warn.${c.id}`);
        }
      } else if (def.kind === 'minutes') {
        keys.push(`settings.${def.key}.question`, `settings.${def.key}.effect`, `settings.${def.key}.warn.long`);
      } else {
        keys.push(`settings.${def.key}.question`, `settings.${def.key}.effect`);
      }
    }
    for (const key of FIXED_SETTINGS) keys.push(`settings.fixed.${key}.name`, `settings.fixed.${key}.value`, `settings.fixed.${key}.why`);
    for (const locale of ['fr', 'en'] as const) {
      for (const key of keys) expect(dictionaries[locale][key], `${locale}:${key}`).toBeTypeOf('string');
    }
  });

  it('translates every simulation effect, event type, event cause and stock quantity the Worker can return (no raw key)', () => {
    for (const locale of ['fr', 'en'] as const) {
      const i18n = createI18n(locale);
      const dict = dictionaries[locale];
      for (const summary of SETTINGS_SIMULATION_SUMMARIES) {
        const known = `settings.simulation.effect.${summary}` in dict || `settings.simulation.effect.${summary}_other` in dict;
        expect(known, `${locale}:${summary}`).toBe(true);
        for (const count of [0, 1, 3]) {
          const text = simulationEffectLabel(i18n, { key: 'S-38', count, summary });
          expect(text).not.toBe(i18n.t('settings.simulation.effect.unknown'));
          expect(text).not.toContain(summary);
        }
      }
      for (const type of UNIT_EVENT_TYPES) {
        expect(dict[`unit.event.${type}`], `${locale}:event ${type}`).toBeTypeOf('string');
        expect(unitEventTypeLabel(i18n, type)).not.toBe(type);
        expect(unitEventTypeLabel(i18n, type)).not.toBe(i18n.t('unit.event.unknown'));
      }
      for (const reason of UNIT_EVENT_REASONS) {
        expect(dict[`unit.reason.${reason}`], `${locale}:reason ${reason}`).toBeTypeOf('string');
        expect(unitEventReasonLabel(i18n, reason)).not.toBe(reason);
        expect(unitEventReasonLabel(i18n, reason)).not.toBe(i18n.t('unit.reason.unknown'));
      }
      for (const q of STOCK_QUANTITY_NAMES) expect(dict[`unit.quantity.${q}`], `${locale}:quantity ${q}`).toBeTypeOf('string');
      for (const actor of ['system', 'api', 'pos', 'user']) expect(unitEventActorLabel(i18n, actor)).not.toBe(actor);
      expect(unitEventActorLabel(i18n, 'Camille')).toBe('Camille');
      // Unknown values (newer Worker): a readable generic label, never the raw key.
      expect(simulationEffectLabel(i18n, { key: 'S-99', count: 2, summary: 'brand_new_effect' as never })).toBe(i18n.t('settings.simulation.effect.unknown'));
      expect(unitEventTypeLabel(i18n, 'brand_new_event')).toBe(i18n.t('unit.event.unknown'));
      expect(unitEventReasonLabel(i18n, 'brand_new:reason')).toBe(i18n.t('unit.reason.unknown'));
      expect(unitEventReasonLabel(i18n, null)).toBeNull();
      expect(unitEventStockLabel(i18n, { stockEffect: 'no write', stockDelta: null, stockQuantity: null })).toBe(i18n.t('unit.stock.no_write'));
      expect(unitEventStockLabel(i18n, { stockEffect: 'something odd', stockDelta: null, stockQuantity: null })).toBe(i18n.t('unit.stock.unknown'));
    }
    const fr = createI18n('fr');
    expect(unitEventStockLabel(fr, { stockEffect: '+1 available', stockDelta: 1, stockQuantity: 'available' })).toBe('+1 en stock « disponible »');
    expect(unitEventStockLabel(fr, { stockEffect: '+1 available' })).toBe('+1 en stock « disponible »');
    expect(unitEventReasonLabel(fr, 'unit_to_verify:lose')).toBe('Vérifiée : introuvable');
    expect(unitEventReasonLabel(fr, 'RESTOCKED')).toBe('Retour remis en stock');
  });

  it('error details: a known key has its own message, an unknown key is never shown raw', () => {
    const en = createI18n('en');
    expect(problemMessage(en, 'validation_failed', 'no_usable_deficit')).toBe('No gap in Shopify at this location: choose “Received now” (Shopify stock +1 per ref).');
    expect(problemMessage(en, 'identifier_conflict', 'duplicate_in_file (row 3)')).toBe(en.t('error.detail.duplicate_in_file'));
    expect(problemMessage(en, 'validation_failed', 'brand_new_detail')).toBe(en.t('error.validation_failed'));
    expect(problemMessage(en, 'invalid_transition', 'unit is SHIPPED')).toBe(`${en.t('error.invalid_transition')} unit is SHIPPED`);
    expect(problemMessage(en, 'brand_new_code', undefined)).toBe(en.t('error.unknown'));
  });

  it('labels every anomaly type of the catalogue 12.7', () => {
    const catalogue = [
      'insufficient_units', 'shipped_without_unit', 'pos_sold_without_unit', 'hold_failed', 'stock_mismatch_missing_units', 'stock_mismatch_extra_units',
      'unit_to_verify', 'return_unidentified', 'inventory_write_conflict', 'outbox_dead', 'unique_variant_policy_changed', 'variant_limit_near',
      'transfer_overdue', 'webhook_silence', 'preexisting_sale_to_designate', 'shipped_unit_to_confirm', 'order_out_of_window', 'return_unit_mismatch',
      'unique_product_unpublished', 'variant_deleted', 'native_shipment_to_designate', 'native_receipt_to_designate', 'mode_conversion_in_progress',
      'pos_lock_conflict', 'draft_hold_released', 'untracked_to_confirm', 'storage_high', 'hold_released_manually', 'native_shipment_rejected',
      'unique_product_left_archived', 'awaiting_unit', 'missing_required_attribute', 'inventory_invariant_violation', 'reconnect_required',
      'bulk_operation_slow', 'unique_variant_missing', 'invalid_serial_property', 'tracking_disabled_in_shopify', 'units_on_inactive_location',
    ];
    for (const type of catalogue) {
      expect(dictionaries.fr[`anomaly.type.${type}`], type).toBeTypeOf('string');
      expect(dictionaries.en[`anomaly.type.${type}`], type).toBeTypeOf('string');
    }
  });

  it('has no visible text hard-coded in the screens and components (strings go through t())', () => {
    const files = walk(SRC).filter((f) => /\.tsx$/.test(f) && !f.includes('/test/'));
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      // JSX text between tags that contains letters and is not an expression; attributes with literal text.
      for (const m of source.matchAll(/>\s*([^<>{}\n]*[A-Za-zÀ-ÿ]{3,}[^<>{}\n]*)\s*</g)) {
        const text = (m[1] ?? '').trim();
        const looksLikeCode = /(===|!==|&&|\|\||=>|>=|<=|\)\s*[:?]|\?\s*\(|\bnew\s|\bas\s+[A-Z]|[=(]\s*$)/.test(text) || /^[\w.]+$/.test(text);
        if (text && !looksLikeCode) offenders.push(`${relative(SRC, file)}: ${text}`);
      }
      for (const m of source.matchAll(/\b(?:label|heading|placeholder|details|aria-label|accessibilityLabel)="([^"{}]*[A-Za-zÀ-ÿ]{3,}[^"{}]*)"/g)) {
        if (m[1] !== 'Serialis') offenders.push(`${relative(SRC, file)}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('Garde-fous de l’interface (T-UX-07)', () => {
  const sources = walk(SRC)
    .filter((f) => /\.(tsx?|ts)$/.test(f) && !f.includes('/test/') && !f.includes('/api/mock.ts') && !f.endsWith('.d.ts'))
    .map((f) => ({ file: relative(SRC, f), source: readFileSync(f, 'utf8') }));

  it('no view uses the camera or a scanner (15.1: no scan function)', () => {
    for (const { file, source } of sources) {
      expect(source, file).not.toMatch(/getUserMedia|BarcodeDetector|mediaDevices|capture=["']environment/i);
    }
  });

  it('no view reads or shows customer data (P8: order number and link only)', () => {
    for (const { file, source } of sources) {
      // Settings › Users shows the first name of the shop's staff (`AppUser.firstName`, 15.8 « donnée du
      // personnel de la boutique, jamais d'un client »): the only file allowed to read that field.
      const forbidden = file.endsWith('UsersSection.tsx')
        ? /\b(customerName|customerEmail|shippingAddress|billingAddress|lastName|phoneNumber)\b/
        : /\b(customerName|customerEmail|shippingAddress|billingAddress|firstName|lastName|phoneNumber)\b/;
      expect(source, file).not.toMatch(forbidden);
    }
  });

  it('the designation field submits on Enter only through the typed-ref rule (no click handler on suggestions)', () => {
    const designation = sources.find((s) => s.file.endsWith('DesignationInput.tsx'))?.source ?? '';
    const list = designation.slice(designation.indexOf('designation-suggestions'));
    expect(list.slice(0, 400)).not.toMatch(/onClick|onPress/);
  });
});
