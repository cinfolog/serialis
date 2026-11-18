// Generates each extension's `locales/` folder (fr.default.json, en.json) from the single source in
// extensions/shared/locales/{fr,en}.json. Shopify bundles an extension's own locales folder, so shared
// namespaces (common, errors, designation...) are copied into every extension that needs them.
// Usage: node scripts/sync-locales.mjs [--check]   (--check fails when a generated file is out of date)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (lang) => JSON.parse(readFileSync(join(root, 'shared', 'locales', `${lang}.json`), 'utf8'));

/** Namespaces shared by every extension (common UI, errors, designation input, unit states). */
const SHARED = ['common', 'designation', 'errors', 'states'];
/** Extension folder -> own namespaces. */
export const EXTENSIONS = {
  'variant-block': ['variantBlock'],
  'product-block': ['productBlock'],
  'order-block': ['orderBlock'],
  'order-action': ['orderBlock', 'orderAction'],
  'variant-action': ['variantAction'],
};
// Default locale is French (the first target market); English is the fallback translation.
const FILES = { fr: 'fr.default.json', en: 'en.json' };

export function build(ext, lang) {
  const src = source(lang);
  // `name` and `description` are referenced from shopify.extension.toml as `t:name` and `t:description`.
  const out = { name: src.extensionMeta[ext].name, description: src.extensionMeta[ext].description };
  for (const ns of [...SHARED, ...EXTENSIONS[ext]]) out[ns] = src[ns];
  return `${JSON.stringify(out, null, 2)}\n`;
}

const check = process.argv.includes('--check');
let stale = 0;
for (const ext of Object.keys(EXTENSIONS)) {
  for (const lang of Object.keys(FILES)) {
    const path = join(root, ext, 'locales', FILES[lang]);
    const next = build(ext, lang);
    if (check) {
      if (!existsSync(path) || readFileSync(path, 'utf8') !== next) {
        console.error(`out of date: ${ext}/locales/${FILES[lang]}`);
        stale++;
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, next);
    }
  }
}
if (stale) process.exit(1);
