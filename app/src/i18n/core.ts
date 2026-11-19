/**
 * Minimal i18n: one dictionary per language, French by default (15.9). Messages use `{name}`
 * placeholders; plural forms are separate keys `<base>_one` / `<base>_other` (`Intl.PluralRules`
 * picks one when `count` is passed), or ICU plural arguments `{n, plural, one {# ligne} other {# lignes}}`
 * when a message holds several counts.
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
  return format(template, locale, params);
}

/** Index of the `}` closing the `{` at `open`, or -1. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

const PLURAL = /^\s*(\w+)\s*,\s*plural\s*,([\s\S]*)$/;

/** Branches of an ICU plural argument: `one {# ligne} other {# lignes}` (and `=0 {…}`). */
function pluralBranches(body: string): Map<string, string> {
  const branches = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    const m = /^\s*(=\d+|zero|one|two|few|many|other)\s*\{/.exec(body.slice(i));
    if (!m) break;
    const open = i + m[0].length - 1;
    const end = closing(body, open);
    if (end < 0) break;
    branches.set(m[1]!, body.slice(open + 1, end));
    i = end + 1;
  }
  return branches;
}

/**
 * Fills `{name}` placeholders and ICU plural arguments `{n, plural, one {# ligne} other {# lignes}}`
 * (`#` = the number formatted for the language), so that one message can hold several counts.
 */
function format(template: string, locale: Locale, params?: Params): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('{', i);
    if (open < 0) break;
    const end = closing(template, open);
    if (end < 0) break;
    out += template.slice(i, open);
    const inner = template.slice(open + 1, end);
    const plural = PLURAL.exec(inner);
    if (plural) {
      const name = plural[1]!;
      const value = params?.[name];
      const n = typeof value === 'number' ? value : Number(value);
      const branches = pluralBranches(plural[2]!);
      const branch = branches.get(`=${n}`) ?? branches.get(Number.isFinite(n) ? new Intl.PluralRules(locale).select(n) : 'other') ?? branches.get('other') ?? '';
      const shown = Number.isFinite(n) ? new Intl.NumberFormat(locale).format(n) : String(value ?? '');
      out += format(branch.replace(/#/g, shown), locale, params);
    } else if (/^\w+$/.test(inner)) {
      out += String(params?.[inner] ?? `{${inner}}`);
    } else {
      out += template.slice(open, end + 1);
    }
    i = end + 1;
  }
  return out + template.slice(i);
}

/** Argument names of a message: simple placeholders and plural arguments, inner ones included (tests). */
export function placeholderNames(template: string): string[] {
  const names = new Set<string>();
  const walk = (text: string) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) return;
      const end = closing(text, open);
      if (end < 0) return;
      const inner = text.slice(open + 1, end);
      const plural = PLURAL.exec(inner);
      if (plural) {
        names.add(plural[1]!);
        for (const branch of pluralBranches(plural[2]!).values()) walk(branch);
      } else if (/^\w+$/.test(inner)) names.add(inner);
      i = end + 1;
    }
  };
  walk(template);
  return [...names].sort();
}

export function hasMessage(dict: Record<string, string>, key: string): boolean {
  return key in dict || `${key}_other` in dict;
}
