import type { ClientErrorCode } from './api-client';
import { ApiError } from './api-client';
import { PROBLEM_DETAIL_KEYS, type ProblemDetailKey } from '@serialis/contract';

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

const DETAIL_KEYS: ReadonlySet<string> = new Set<string>(PROBLEM_DETAIL_KEYS);

/**
 * Stable detail key of the contract at the start of a server detail (`no_usable_deficit`,
 * `duplicate_in_file (row 3)`…), or null.
 */
export function detailKey(detail: string | undefined): ProblemDetailKey | null {
  const m = detail ? /^([a-z_]+)\b/.exec(detail) : null;
  return m && DETAIL_KEYS.has(m[1]!) ? (m[1] as ProblemDetailKey) : null;
}

/**
 * Message of a code and its detail (15.7): a known detail key has its own message, which replaces the
 * generic text of the code; a readable server sentence is appended in parentheses; any other key-like
 * detail is dropped, never shown raw (15.9).
 */
export function codeMessage(t: Translate, code: string, detail?: string): string {
  const key = detailKey(detail);
  if (key) return t(`errors.detail.${key}`);
  const base = t(errorKey(code));
  return detail && /\s/.test(detail.trim()) ? `${base} (${detail})` : base;
}

/** Clear message for a failed call (15.5 typical errors, 15.7), with the server detail when it helps. */
export function errorMessage(t: Translate, error: unknown): string {
  if (error instanceof ApiError) return codeMessage(t, error.code, error.detail);
  // A non-API failure (exception in the extension itself) keeps a short technical trace so a merchant's
  // screenshot is enough to diagnose it (recette du 18/11: « unexpected error » without any clue).
  if (error instanceof Error) return `${t(errorKey('unknown'))} (${error.name}: ${error.message.slice(0, 120)})`;
  return t(errorKey('unknown'));
}

/** Adapts Shopify's `i18n.translate` to {@link Translate}. */
export function fromShopifyI18n(i18n: { translate: (key: string, options?: Record<string, string | number>) => unknown }): Translate {
  return (key, vars) => {
    const out = i18n.translate(key, vars);
    return Array.isArray(out) ? out.join('') : String(out);
  };
}
