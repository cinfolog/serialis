import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { luhnValid, normalizeIdentifier, uniquenessScopeKey, validateIdentifier } from '../src/identifiers.js';
import {
  SETTING_KEYS,
  SETTINGS,
  isValidSettingValue,
  resolveSetting,
  settingWarning,
  validateStoredSetting,
  type SettingDefinition,
  type StoredSetting,
} from '../src/settings.js';

const MVP_KEYS = ['S-05', 'S-08', 'S-09', 'S-11', 'S-17', 'S-22', 'S-25', 'S-35', 'S-36', 'S-37', 'S-38', 'S-40'];

describe('settings catalogue — spec 6.6 and 19.4', () => {
  it('contains the MVP settings plus S-01 and S-24 fixed to "do not block"', () => {
    for (const k of MVP_KEYS) expect(SETTING_KEYS).toContain(k);
    expect(SETTINGS['S-01'].fixedInMvp).toBe('do_not_block');
    expect(SETTINGS['S-24'].fixedInMvp).toBe('do_not_block');
    expect(resolveSetting('S-01', {}, [{ scopeType: 'shop', scopeId: '', key: 'S-01', value: 'hold' }])).toBe('do_not_block');
  });

  it('every default value is valid and listed (catalogue consistency)', () => {
    for (const k of SETTING_KEYS) expect(isValidSettingValue(k, SETTINGS[k].default)).toBe(true);
  });

  it('T-SET-01 — accepts each allowed value, refuses a value off the list or a scope not allowed', () => {
    for (const k of SETTING_KEYS) {
      const def = SETTINGS[k] as SettingDefinition;
      if (def.fixedInMvp !== undefined) continue;
      const scope = def.scopes[0] ?? 'shop';
      const scopeId = scope === 'shop' ? '' : 'x';
      if (def.kind === 'enum') {
        for (const v of def.values) expect(validateStoredSetting({ scopeType: scope, scopeId, key: k, value: v })).toEqual({ ok: true });
      }
      expect(validateStoredSetting({ scopeType: scope, scopeId, key: k, value: 'not-a-value' })).toEqual({ ok: false, error: 'invalid_value' });
    }
    expect(validateStoredSetting({ scopeType: 'location', scopeId: 'loc', key: 'S-08', value: 'first' })).toEqual({
      ok: false,
      error: 'scope_not_allowed',
    });
    expect(validateStoredSetting({ scopeType: 'shop', scopeId: '', key: 'S-99', value: 1 })).toEqual({ ok: false, error: 'unknown_key' });
    expect(validateStoredSetting({ scopeType: 'shop', scopeId: '', key: 'S-01', value: 'hold' })).toEqual({ ok: false, error: 'fixed_in_mvp' });
    expect(validateStoredSetting({ scopeType: 'shop', scopeId: '', key: 'S-22', value: 60_000 })).toEqual({ ok: false, error: 'invalid_value' });
  });

  it('T-SET-02 — applied value: tracked item, then location, then shop, then default; removal restores inheritance', () => {
    const stored: StoredSetting[] = [
      { scopeType: 'shop', scopeId: '', key: 'S-05', value: 'fefo' },
      { scopeType: 'tracked_item', scopeId: 'item-1', key: 'S-05', value: 'manual' },
    ];
    expect(resolveSetting('S-05', { trackedItemId: 'item-1', locationId: 'loc-a' }, stored)).toBe('manual');
    expect(resolveSetting('S-05', { trackedItemId: 'item-2', locationId: 'loc-a' }, stored)).toBe('fefo');
    expect(resolveSetting('S-05', { trackedItemId: 'item-1' }, stored.slice(0, 1))).toBe('fefo');
    expect(resolveSetting('S-05', { trackedItemId: 'item-1' }, [])).toBe('fifo');
    // S-22 allows the location scope: location beats shop.
    const grace: StoredSetting[] = [
      { scopeType: 'shop', scopeId: '', key: 'S-22', value: 20 * 60_000 },
      { scopeType: 'location', scopeId: 'loc-a', key: 'S-22', value: 30 * 60_000 },
    ];
    expect(resolveSetting('S-22', { locationId: 'loc-a' }, grace)).toBe(30 * 60_000);
    expect(resolveSetting('S-22', { locationId: 'loc-b' }, grace)).toBe(20 * 60_000);
  });

  it('T-SET-02 — values stored on a scope the catalogue does not allow are ignored', () => {
    const stored: StoredSetting[] = [{ scopeType: 'location', scopeId: 'loc-a', key: 'S-05', value: 'manual' }];
    expect(resolveSetting('S-05', { locationId: 'loc-a' }, stored)).toBe('fifo');
  });

  it('T-SET-02 — on an externally managed location, S-22 is 2 h whatever the shop value', () => {
    const stored: StoredSetting[] = [{ scopeType: 'shop', scopeId: '', key: 'S-22', value: 20 * 60_000 }];
    expect(resolveSetting('S-22', { locationId: 'loc-x', externallyManagedLocation: true }, stored)).toBe(2 * 3_600_000);
    const onLoc: StoredSetting[] = [...stored, { scopeType: 'location', scopeId: 'loc-x', key: 'S-22', value: 15 * 60_000 }];
    expect(resolveSetting('S-22', { locationId: 'loc-x', externallyManagedLocation: true }, onLoc)).toBe(15 * 60_000);
  });

  it('S-22: a duration set on the shop applies, within 5 min and 24 h', () => {
    expect(resolveSetting('S-22', {}, [{ scopeType: 'shop', scopeId: '', key: 'S-22', value: 3_600_000 }])).toBe(3_600_000);
    expect(isValidSettingValue('S-22', 4 * 60_000)).toBe(false);
    expect(isValidSettingValue('S-22', 25 * 3_600_000)).toBe(false);
    expect(settingWarning('S-22', 3_600_000)).not.toBeNull();
    expect(settingWarning('S-22', 10 * 60_000)).toBeNull();
  });

  it('warns before saving a value that weakens a guarantee (6.6.1)', () => {
    expect(settingWarning('S-17', false)).not.toBeNull();
    expect(settingWarning('S-17', true)).toBeNull();
    expect(settingWarning('S-09', 'auto')).not.toBeNull();
    expect(settingWarning('S-25', 'on_decision')).not.toBeNull();
  });

  it('S-37 default is Luhn for the IMEI identifier type', () => {
    expect(resolveSetting('S-37', { identifierType: 'imei' }, [])).toBe('luhn');
    expect(resolveSetting('S-37', { identifierType: 'serial' }, [])).toBe('none');
    expect(resolveSetting('S-37', { identifierType: 'imei' }, [{ scopeType: 'identifier_type', scopeId: 'imei', key: 'S-37', value: 'none' }])).toBe('none');
  });

  it('S-35 product: identifier uniqueness scoped by product', () => {
    expect(uniquenessScopeKey('shop', 'gid://shopify/Product/1')).toBe('shop');
    expect(uniquenessScopeKey('product', 'gid://shopify/Product/1')).toBe('gid://shopify/Product/1');
  });

  it('S-36: spaces and case normalization can be turned off independently', () => {
    expect(normalizeIdentifier(' ab 12 ')).toBe('AB12');
    expect(normalizeIdentifier(' ab 12 ', { stripSpaces: false, normalizeUpper: true })).toBe('AB 12');
    expect(normalizeIdentifier(' ab 12 ', { stripSpaces: true, normalizeUpper: false })).toBe('ab12');
    expect(isValidSettingValue('S-36', { stripSpaces: false, normalizeUpper: true })).toBe(true);
    expect(isValidSettingValue('S-36', { stripSpaces: false })).toBe(false);
  });

  it('S-37 luhn: IMEI-like identifiers are checked with Luhn', () => {
    expect(luhnValid('356938035643809')).toBe(true);
    expect(validateIdentifier('356938035643809', 'luhn')).toEqual({ ok: true });
    expect(validateIdentifier('356938035643808', 'luhn')).toEqual({ ok: false, reason: 'luhn' });
    expect(validateIdentifier('ABC', 'none')).toEqual({ ok: true });
  });

  it('S-37 regex: identifiers must match the custom expression', () => {
    expect(validateIdentifier('FR-1234', 'regex', 'FR-\\d{4}')).toEqual({ ok: true });
    expect(validateIdentifier('FR-123', 'regex', 'FR-\\d{4}')).toEqual({ ok: false, reason: 'regex' });
    expect(validateIdentifier('FR-1234X', 'regex', 'FR-\\d{4}')).toEqual({ ok: false, reason: 'regex' });
    expect(validateIdentifier('X', 'regex', '(')).toEqual({ ok: false, reason: 'invalid_regex' });
  });

  it('S-40: custom notification settings are accepted and validated', () => {
    expect(isValidSettingValue('S-40', { recipients: ['ops@example.com'], outgoingWebhook: true, dailyDigest: false })).toBe(true);
    expect(isValidSettingValue('S-40', { recipients: ['not-an-email'], outgoingWebhook: true, dailyDigest: false })).toBe(false);
    expect(isValidSettingValue('S-40', { recipients: [], outgoingWebhook: true, dailyDigest: false })).toBe(false);
  });

  it('T-SET-08 — every non-default value references a test that exists in the suite', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => readFileSync(`${dir}/${f}`, 'utf8'))
      .join('\n');
    for (const k of SETTING_KEYS) {
      const def = SETTINGS[k] as SettingDefinition;
      if (def.fixedInMvp !== undefined) continue;
      const nonDefault =
        def.kind === 'enum'
          ? def.values.filter((v) => v !== def.default).map(String)
          : def.kind === 'boolean'
            ? [String(!def.default)]
            : def.kind === 'duration'
              ? ['other']
              : ['custom'];
      for (const v of nonDefault) {
        const ref = def.testRefs[v];
        expect(ref, `${k} = ${v} has no test reference`).toBeTypeOf('string');
        expect(sources.includes(`it('${ref}'`), `${k} = ${v}: test "${ref}" not found`).toBe(true);
      }
    }
  });
});
