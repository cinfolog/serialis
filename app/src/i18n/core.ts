/**
 * Minimal i18n: one dictionary per language, French by default (15.9). Messages use `{name}`
 * placeholders; plural forms are separate keys `<base>_one` / `<base>_other` (`Intl.PluralRules`
 * picks one when `count` is passed), which mirrors ICU plural selection without a parser.
 * Each module declares `defineMessages(fr, en)`: TypeScript refuses a module whose two
 * dictionaries do not have exactly the same keys, so no text can exist in one language only.
 */
export type Locale = 'fr' | 'en';
export type Params = Record<string, string | number>;

export function defineMessages<const K extends string>(fr: Record<K, string>, en: Record<NoInfer<K>, string>) {
  return { fr, en };
}

type Plural<K extends string> = K extends `${infer B}_${'one' | 'other'}` ? B : K;
export type BaseKey<M> = Plural<Extract<keyof M, string>>;

export function translate(dict: Record<string, string>, locale: Locale, key: string, params?: Params): string {
  let template: string | undefined;
  if (params && typeof params['count'] === 'number') {
    const rule = new Intl.PluralRules(locale).select(params['count']);
    template = dict[`${key}_${rule === 'one' ? 'one' : 'other'}`];
  }
  template ??= dict[key];
  if (template === undefined) return key;
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name] ?? `{${name}}`));
}

export function hasMessage(dict: Record<string, string>, key: string): boolean {
  return key in dict || `${key}_other` in dict;
}
