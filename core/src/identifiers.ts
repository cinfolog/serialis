import type { IdentifierNormalization, SettingValues } from './settings.js';

/** Identifier normalization and validation — EF-03, S-35 to S-37. */

export const DEFAULT_NORMALIZATION: IdentifierNormalization = { stripSpaces: true, normalizeUpper: true };

/** `value_norm`: trimmed; inner whitespace removed and upper-cased when the type asks for it (S-36). */
export function normalizeIdentifier(value: string, normalization: IdentifierNormalization = DEFAULT_NORMALIZATION): string {
  let v = value.trim();
  if (normalization.stripSpaces) v = v.replace(/\s+/g, '');
  if (normalization.normalizeUpper) v = v.toUpperCase();
  return v;
}

/** Luhn checksum over digits only (IMEI). */
export function luhnValid(value: string): boolean {
  if (!/^\d{2,}$/.test(value)) return false;
  let sum = 0;
  let double = false;
  for (let i = value.length - 1; i >= 0; i--) {
    let d = value.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export type IdentifierValidation = { ok: true } | { ok: false; reason: 'empty' | 'luhn' | 'regex' | 'invalid_regex' };

/** Validation of a normalized value against the rule of its type (S-37). */
export function validateIdentifier(valueNorm: string, rule: SettingValues['S-37'], regex?: string): IdentifierValidation {
  if (valueNorm === '') return { ok: false, reason: 'empty' };
  if (rule === 'luhn' && !luhnValid(valueNorm)) return { ok: false, reason: 'luhn' };
  if (rule === 'regex') {
    if (regex === undefined) return { ok: false, reason: 'invalid_regex' };
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${regex})$`, 'u');
    } catch {
      return { ok: false, reason: 'invalid_regex' };
    }
    if (!re.test(valueNorm)) return { ok: false, reason: 'regex' };
  }
  return { ok: true };
}

/** `unit_identifiers.scope_key` (S-35): `shop`, or the product the uniqueness is scoped to. */
export function uniquenessScopeKey(scope: SettingValues['S-35'], productGid: string): string {
  return scope === 'shop' ? 'shop' : productGid;
}
