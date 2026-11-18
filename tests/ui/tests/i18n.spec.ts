/**
 * T-UX-05 "textes complets en français et en anglais" and spec 15.9 (French and English from the MVP, no
 * hard-coded string): in a real browser, on every screen and in both languages, no dictionary key, ICU
 * placeholder or "undefined" is visible, the document language follows the user's locale, and no interface
 * text of the other language leaks through.
 *
 * Texts that come from the server (anomaly summaries, event reasons) are outside the dictionaries: the mock
 * serves them in French, so the "other language" check only considers the app's own messages.
 */
import { dictionaries, translator } from './messages';
import { expect, open, test, visibleText } from './support';

const SCREENS: Array<{ name: string; path: string; heading: string }> = [
  { name: 'home', path: '/', heading: 'home.heading' },
  { name: 'units', path: '/units', heading: 'units.heading' },
  { name: 'tracked-items', path: '/tracked-items', heading: 'tracked.heading' },
  { name: 'anomalies', path: '/anomalies', heading: 'anomalies.heading' },
  { name: 'imports', path: '/imports', heading: 'imports.heading' },
  { name: 'settings', path: '/settings', heading: 'settings.heading' },
  { name: 'settings-health', path: '/settings/health?mock_health=degraded', heading: 'health.heading' },
  { name: 'wizard', path: '/start', heading: 'wizard.heading' },
  { name: 'not-found', path: '/nope', heading: 'shell.not_found.heading' },
];

const KEYS = new Set(Object.keys(dictionaries.fr));
const PREFIXES = new Set(Object.keys(dictionaries.fr).map((k) => k.split('.')[0]));

/** Own messages of one language that are absent from the other (same text in both languages ignored). */
function exclusive(from: 'fr' | 'en', other: 'fr' | 'en'): string[] {
  const otherValues = new Set(Object.values(dictionaries[other]));
  return Object.entries(dictionaries[from])
    .filter(([key, value]) => key !== 'app.name' && typeof value === 'string' && value.length >= 14 && !/[{}\n]/.test(value) && !otherValues.has(value))
    .map(([, value]) => value);
}

function untranslatedTokens(text: string): string[] {
  const found: string[] = [];
  for (const token of text.split(/[\s,;:()«»“”"]+/)) {
    const bare = token.replace(/[.…]+$/, '');
    if (KEYS.has(bare) || (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9_]*)+$/.test(bare) && PREFIXES.has(bare.split('.')[0]!))) found.push(token);
  }
  if (/\{\w+\}|\bundefined\b|\bNaN\b|\[object /.test(text)) found.push('(placeholder, undefined or NaN)');
  return found;
}

for (const locale of ['fr', 'en'] as const) {
  const other = locale === 'fr' ? 'en' : 'fr';
  const t = translator(locale);
  const foreign = exclusive(other, locale);

  test.describe(`texts [${locale}]`, () => {
    for (const screen of SCREENS) {
      test(`${screen.name}: translated, in ${locale} only`, async ({ page }) => {
        await open(page, screen.path, { locale });
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expect(page).toHaveTitle(new RegExp(`^${t(screen.heading)}`));
        await expect(page.locator('s-page').first()).toHaveAttribute('heading', t(screen.heading));
        const text = await visibleText(page);
        expect(untranslatedTokens(text), 'untranslated keys').toEqual([]);
        const leaked = foreign.filter((value) => text.includes(value));
        expect(leaked, `${other} interface texts visible in ${locale}`).toEqual([]);
      });
    }

    test('flows: add refs result, designation hints, confirmation dialog', async ({ page }) => {
      await open(page, '/units?add=1', { locale });
      await page.getByTestId('refs-text').locator('textarea').fill('NEW-1\nNEW-1\nSN-UR500-M-51200\nbad!');
      await page.getByTestId('refs-check').getByRole('button').click();
      await expect(page.getByTestId('refs-summary')).toBeVisible();
      await page.getByTestId('refs-submit').getByRole('button').click();
      await expect(page.getByTestId('dialog-confirm')).toBeVisible();
      let text = await visibleText(page);
      expect(untranslatedTokens(text)).toEqual([]);
      expect(foreign.filter((v) => text.includes(v))).toEqual([]);
      await page.getByTestId('dialog-confirm').getByRole('button').click();
      await expect(page.getByTestId('refs-result')).toBeVisible();
      text = await visibleText(page);
      expect(untranslatedTokens(text)).toEqual([]);

      await open(page, '/anomalies', { locale });
      await page.getByTestId('action-ano-5-assign_unit').getByRole('button').click();
      await page.getByTestId('designation-input').locator('input').fill('SN-UR');
      await expect(page.getByTestId('designation-suggestions')).toBeVisible();
      text = await visibleText(page);
      expect(untranslatedTokens(text)).toEqual([]);
      expect(foreign.filter((v) => text.includes(v))).toEqual([]);
    });
  });
}

test('the two dictionaries have the same keys (the browser build ships both)', () => {
  expect(Object.keys(dictionaries.en).sort()).toEqual(Object.keys(dictionaries.fr).sort());
});

test('the translated-key detector catches a leaked key (guard against a vacuous test)', () => {
  expect(untranslatedTokens('Réglages nav.units Anomalies')).toEqual(['nav.units']);
  expect(untranslatedTokens('Page {count} undefined')).not.toEqual([]);
  expect(untranslatedTokens('Boutique velos-demo.myshopify.com et cinfolog.com')).toEqual([]);
});
