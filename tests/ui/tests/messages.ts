import { createI18n, dictionaries } from '../../../app/src/i18n/index';

// The app's own dictionaries and translator: single source for expected labels and for the "no untranslated key" check.
export { dictionaries };

/** `t(key, params)` for a locale; keys are plain strings here (some are built from fixture data). */
export function translator(locale: 'fr' | 'en') {
  const i18n = createI18n(locale);
  return (key: string, params?: Record<string, string | number>): string => i18n.t(key as never, params);
}
