import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError, createTranslator, errorKey, errorMessage, fromShopifyI18n, type Dict } from '../src';

const extRoot = join(import.meta.dirname, '..', '..');
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Dict;
const source = { fr: readJson(join(extRoot, 'shared', 'locales', 'fr.json')), en: readJson(join(extRoot, 'shared', 'locales', 'en.json')) };

/** Flattens a dictionary to dotted leaf keys; a plural object (one/other...) counts as one leaf. */
function leaves(node: unknown, prefix = ''): string[] {
  if (typeof node === 'string') return [prefix];
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.includes('other') && keys.every((k) => ['zero', 'one', 'two', 'few', 'many', 'other'].includes(k))) return [prefix];
  return keys.flatMap((k) => leaves(obj[k], prefix ? `${prefix}.${k}` : k));
}

function plurals(node: unknown, prefix = ''): Array<[string, string[]]> {
  if (typeof node === 'string') return [];
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.includes('other') && keys.every((k) => ['zero', 'one', 'two', 'few', 'many', 'other'].includes(k))) return [[prefix, keys]];
  return keys.flatMap((k) => plurals(obj[k], prefix ? `${prefix}.${k}` : k));
}

describe('createTranslator', () => {
  const fr = createTranslator({ a: { b: 'Salut {{name}}' }, n: { one: '{{count}} chose', many: '{{count}} de choses', other: '{{count}} choses' } }, 'fr');
  const en = createTranslator({ n: { one: '{{count}} thing', other: '{{count}} things' } }, 'en');

  it('resolves dotted keys and interpolates', () => {
    expect(fr('a.b', { name: 'Zoé' })).toBe('Salut Zoé');
  });
  it('selects the plural form of the locale (0 and 1 are singular in French)', () => {
    expect(fr('n', { count: 0 })).toBe('0 chose');
    expect(fr('n', { count: 1 })).toBe('1 chose');
    expect(fr('n', { count: 3 })).toBe('3 choses');
    expect(en('n', { count: 1 })).toBe('1 thing');
    expect(en('n', { count: 2 })).toBe('2 things');
  });
  it('returns the key when missing', () => {
    expect(fr('x.y')).toBe('x.y');
  });
});

describe('errorMessage', () => {
  const t = createTranslator(source.fr, 'fr');
  it('translates a problem code and appends the server detail', () => {
    const e = new ApiError(409, 'unit_not_available', 'x', { type: '', title: '', status: 409, code: 'unit_not_available', detail: 'commande #1042' });
    expect(errorMessage(t, e)).toBe(`${t('errors.unit_not_available')} (commande #1042)`);
  });
  it('falls back to the generic message for unknown codes and non-API errors', () => {
    expect(errorKey('brand_new_code')).toBe('errors.unknown');
    expect(errorMessage(t, new Error('boom'))).toBe(t('errors.unknown'));
  });
  it('covers every error code of the contract', () => {
    const codes = readFileSync(join(extRoot, '..', 'api', 'contract', 'src', 'index.ts'), 'utf8').match(/export type ErrorCode =([^;]+);/)![1]!;
    for (const [, code] of codes.matchAll(/'([a-z_]+)'/g)) expect(source.fr['errors'], code).toHaveProperty(code!);
  });
});

describe('fromShopifyI18n', () => {
  it('joins array results and stringifies', () => {
    const t = fromShopifyI18n({ translate: (k) => (k === 'a' ? ['x', 'y'] : 'z') });
    expect(t('a')).toBe('xy');
    expect(t('b')).toBe('z');
  });
});

describe('locales (FR default, EN)', () => {
  it('French and English sources have exactly the same keys', () => {
    expect(leaves(source.en).sort()).toEqual(leaves(source.fr).sort());
  });

  it('plural objects define every CLDR form of their language', () => {
    for (const [key, forms] of plurals(source.fr)) expect(forms.sort(), `fr ${key}`).toEqual(['many', 'one', 'other']);
    for (const [key, forms] of plurals(source.en)) expect(forms.sort(), `en ${key}`).toEqual(['one', 'other']);
  });

  it('no translation is empty', () => {
    for (const lang of ['fr', 'en'] as const) {
      const t = createTranslator(source[lang], lang);
      for (const key of leaves(source[lang])) expect(t(key, { count: 2 }).trim(), `${lang} ${key}`).not.toBe('');
    }
  });

  it("each extension's generated locales folder is up to date with the sources", () => {
    expect(() => execFileSync('node', [join(extRoot, 'shared', 'scripts', 'sync-locales.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow();
  });

  it('every extension ships fr.default.json and en.json', () => {
    for (const ext of ['variant-block', 'product-block', 'order-block', 'order-action']) {
      const files = readdirSync(join(extRoot, ext, 'locales')).sort();
      expect(files, ext).toEqual(['en.json', 'fr.default.json']);
    }
  });
});

describe('translation keys used in code exist in every extension (no hard-coded string left behind)', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
    });
  const forms = (prefix: string, values: string[]) => values.map((v) => `${prefix}${v}`);
  const dynamic: Record<string, string[]> = {
    'states.${state}': forms('states.', ['INCOMING', 'AVAILABLE', 'HELD', 'ALLOCATED', 'QUALITY_CONTROL', 'DAMAGED', 'IN_TRANSIT', 'SHIPPED', 'RETURN_PENDING', 'TO_VERIFY', 'LOST', 'SCRAPPED', 'UNTRACKED']),
    'variantBlock.line_${l.status}': forms('variantBlock.line_', ['duplicate', 'known', 'invalid']),
    'orderBlock.status_${allocation.status}': forms('orderBlock.status_', ['active', 'fulfilled', 'released', 'returned']),
    'orderAction.title_${action.type}': forms('orderAction.title_', ['allocate', 'replace', 'remove']),
    'orderAction.confirm_${action.type}': forms('orderAction.confirm_', ['allocate', 'replace', 'remove']),
  };
  // Keys built outside a literal t('...') call (effect keys, origins, done messages, headings, designation messages).
  const fixed = [
    ...forms('orderBlock.origin_', ['auto', 'pick', 'pos', 'draft', 'api', 'late', 'migration']),
    ...forms('orderAction.done_', ['allocate', 'replace', 'remove']),
    ...forms('orderAction.effect_', ['allocate', 'replace', 'remove']),
    ...forms('designation.', ['exact', 'suffix', 'ambiguous', 'tooShort', 'unknown']),
    'variantBlock.heading', 'productBlock.heading', 'orderBlock.heading',
  ];

  for (const ext of ['variant-block', 'product-block', 'order-block', 'order-action']) {
    it(ext, () => {
      const files = [...walk(join(extRoot, ext, 'src')), ...walk(join(extRoot, 'shared', 'src'))].filter((f) => !f.endsWith('testing.ts'));
      const used = new Set<string>(fixed);
      for (const f of files) {
        const text = readFileSync(f, 'utf8');
        for (const m of text.matchAll(/\bt\(\s*[`']([^`']+)[`']/g)) {
          const key = m[1]!;
          if (key.includes('${')) {
            const expansion = dynamic[key];
            if (!expansion) throw new Error(`unknown dynamic key ${key} in ${f}`);
            expansion.forEach((k) => used.add(k));
          } else used.add(key);
        }
      }
      // Extension names/descriptions are read by shopify.extension.toml.
      used.add('name');
      used.add('description');
      for (const [file, lang] of [['fr.default.json', 'fr'], ['en.json', 'en']] as const) {
        const t = createTranslator(readJson(join(extRoot, ext, 'locales', file)), lang);
        const own = ext === 'order-action' ? ['orderBlock', 'orderAction'] : [ext === 'order-block' ? 'orderBlock' : ext === 'product-block' ? 'productBlock' : 'variantBlock'];
        const relevant = [...used].filter((k) => ['common', 'errors', 'designation', 'states', 'name', 'description', ...own].includes(k.split('.')[0]!));
        const missing = relevant.filter((k) => t(k, { count: 2 }) === k);
        expect(missing, `${ext} ${lang}`).toEqual([]);
      }
    });
  }
});
