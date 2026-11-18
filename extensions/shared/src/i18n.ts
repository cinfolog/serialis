import type { ClientErrorCode } from './api-client';
import { ApiError } from './api-client';

/** Translation function: in production `shopify.i18n.translate` (extension `locales/*.json`). */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export type Dict = { [key: string]: string | Dict };

/**
 * Minimal translator over a locale dictionary, same syntax as Shopify's `i18n.translate`:
 * dotted keys, `{{name}}` placeholders, and plural objects (`one` / `other` ...) selected with `count`.
 * Used by tests and as the fallback when no Shopify i18n is available.
 */
export function createTranslator(dict: Dict, locale: string): Translate {
  const rules = new Intl.PluralRules(locale);
  return (key, vars = {}) => {
    let node: string | Dict | undefined = dict;
    for (const part of key.split('.')) {
      if (node && typeof node === 'object') node = node[part];
      else {
        node = undefined;
        break;
      }
    }
    if (node && typeof node === 'object') {
      const count = vars['count'];
      const form = typeof count === 'number' ? rules.select(count) : 'other';
      const picked = node[form] ?? node['other'];
      node = typeof picked === 'string' ? picked : undefined;
    }
    if (typeof node !== 'string') return key;
    return node.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(vars[name] ?? ''));
  };
}

const KNOWN_ERROR_CODES: ReadonlySet<ClientErrorCode> = new Set<ClientErrorCode>([
  'unauthenticated', 'forbidden', 'not_found', 'validation_failed', 'idempotency_conflict', 'precondition_failed',
  'rate_limited', 'unit_not_available', 'identifier_conflict', 'invalid_transition', 'variant_mismatch',
  'location_mismatch', 'ambiguous_ref', 'unknown_ref', 'not_tracked', 'emergency_stop', 'simulation_expired',
  'incompatible_settings', 'network_error', 'unknown',
]);

/** Locale key of an error code (`errors.<code>`); unknown codes fall back to `errors.unknown`. */
export function errorKey(code: string): string {
  return `errors.${KNOWN_ERROR_CODES.has(code as ClientErrorCode) ? code : 'unknown'}`;
}

/** Clear message for a failed call (15.5 typical errors, 15.7), with the server detail appended when present. */
export function errorMessage(t: Translate, error: unknown): string {
  if (error instanceof ApiError) {
    const base = t(errorKey(error.code));
    return error.detail ? `${base} (${error.detail})` : base;
  }
  return t(errorKey('unknown'));
}

/** Message of a rejected batch line or item-level error. */
export function codeMessage(t: Translate, code: string, detail?: string): string {
  const base = t(errorKey(code));
  return detail ? `${base} (${detail})` : base;
}

/** Adapts Shopify's `i18n.translate` to {@link Translate}. */
export function fromShopifyI18n(i18n: { translate: (key: string, options?: Record<string, string | number>) => unknown }): Translate {
  return (key, vars) => {
    const out = i18n.translate(key, vars);
    return Array.isArray(out) ? out.join('') : String(out);
  };
}
