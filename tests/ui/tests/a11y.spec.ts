/**
 * T-UX-03 (spec 15.10): automated accessibility test (axe-core, WCAG 2.x A/AA tags) on every MVP screen,
 * no serious or critical violation. Runs in French and English.
 *
 * With the offline shim (default) axe evaluates the app's own markup on top of simplified components; with
 * UI_TESTS_REAL_CDN=1 it evaluates the real Polaris web components (their shadow DOM included): that is the
 * run that counts for the release grid (the shim says nothing about Polaris' internal contrast or labels).
 */
import AxeBuilder from '@axe-core/playwright';
import { dictionaries } from './messages';
import { expect, expectNoSeriousViolation, fillField, goTo, mockState, open, ready, test, type Scenario } from './support';

const SCREENS: Array<{ name: string; path: string }> = [
  { name: 'home', path: '/' },
  { name: 'units', path: '/units' },
  { name: 'tracked-items', path: '/tracked-items' },
  { name: 'anomalies', path: '/anomalies' },
  { name: 'anomalies-resolved', path: '/anomalies?status=resolved' },
  { name: 'imports', path: '/imports' },
  { name: 'settings', path: '/settings' },
  { name: 'settings-health', path: '/settings/health' },
  { name: 'settings-health-alerts', path: '/settings/health?mock_health=degraded' },
  { name: 'not-found', path: '/nope' },
];

for (const locale of ['fr', 'en'] as const) {
  const t = (key: string) => dictionaries[locale][key] as string;
  const scenario: Scenario = { locale };

  test.describe(`T-UX-03 axe [${locale}]`, () => {
    for (const screen of SCREENS) {
      test(`screen ${screen.name}`, async ({ page }, testInfo) => {
        await open(page, screen.path, scenario);
        await expectNoSeriousViolation(page, testInfo, `${screen.name}-${locale}`);
      });
    }

    test('unit page', async ({ page }, testInfo) => {
      await open(page, '/units', scenario);
      const id = await mockState(page, (m) => m.units[0].id as string);
      await goTo(page, t('nav.home'));
      await page.goto(`/units/${id}?mock_delay=0${locale === 'en' ? '&mock_locale=en' : ''}`);
      await ready(page);
      await expect(page.getByTestId('unit-events')).toBeVisible();
      await expectNoSeriousViolation(page, testInfo, `unit-page-${locale}`);
    });

    test('startup wizard, every step', async ({ page }, testInfo) => {
      await open(page, '/start', scenario);
      // The seeded shop resumes on the last step; walk back to the first one.
      await expect(page.getByTestId('wizard-blocks')).toBeVisible();
      await expectNoSeriousViolation(page, testInfo, `wizard-blocks-${locale}`);
      await page.getByRole('button', { name: t('common.back'), exact: true }).click();
      await expect(page.getByTestId('wizard-gap-table')).toBeVisible();
      await expectNoSeriousViolation(page, testInfo, `wizard-gap-${locale}`);
      await page.getByRole('button', { name: t('wizard.gap.add_more'), exact: true }).click();
      await expect(page.getByTestId('refs-text')).toBeVisible();
      await expectNoSeriousViolation(page, testInfo, `wizard-refs-${locale}`);
      await page.getByRole('button', { name: t('common.back'), exact: true }).click();
      await expect(page.getByTestId('wizard-pick')).toBeVisible();
      await expectNoSeriousViolation(page, testInfo, `wizard-products-${locale}`);
    });

    test('startup wizard on a new shop (empty state)', async ({ page }, testInfo) => {
      await open(page, '/start', { ...scenario, empty: true });
      await expect(page.getByTestId('wizard-pick')).toBeVisible();
      await expectNoSeriousViolation(page, testInfo, `wizard-empty-${locale}`);
    });
  });
}

test.describe('T-UX-03 axe, interactive states', () => {
  test('add refs: pasted list checked, then confirmation dialog open', async ({ page }, testInfo) => {
    await open(page, '/units?add=1');
    await fillField(page, 'refs-text', 'NEW-001\nNEW-002\nSN-UR500-M-51200\nNEW-001\nbad ref!');
    await page.getByTestId('refs-check').getByRole('button').click();
    await expect(page.getByTestId('refs-check-table')).toBeVisible();
    await expectNoSeriousViolation(page, testInfo, 'add-refs-checked');
    await page.getByTestId('refs-submit').getByRole('button').click();
    await expect(page.getByTestId('dialog-confirm')).toBeVisible();
    await expectNoSeriousViolation(page, testInfo, 'add-refs-dialog');
  });

  test('anomalies: designation input open with suggestions', async ({ page }, testInfo) => {
    await open(page, '/anomalies');
    await page.getByTestId('action-ano-5-assign_unit').getByRole('button').click();
    await fillField(page, 'designation-input', 'SN-UR');
    await expect(page.getByTestId('designation-suggestions')).toBeVisible();
    await expectNoSeriousViolation(page, testInfo, 'anomalies-designation');
  });

  test('settings: unsaved change shows the save bar', async ({ page }, testInfo) => {
    await open(page, '/settings');
    const field = page.locator('[data-testid^="input-"]').first();
    await expect(field).toBeVisible();
    await field.locator('select').selectOption({ index: 1 });
    await expect(page.getByTestId('save-bar')).toBeVisible();
    await expectNoSeriousViolation(page, testInfo, 'settings-save-bar');
  });

  test('emergency stop banner and resume dialog', async ({ page }, testInfo) => {
    await open(page, '/', { stop: true });
    await expect(page.getByTestId('banner-emergency')).toBeVisible();
    await page.getByTestId('resume-open').getByRole('button').click();
    await expect(page.getByTestId('dialog-confirm')).toBeVisible();
    await expectNoSeriousViolation(page, testInfo, 'emergency-resume-dialog');
  });

  test('empty shop: home and units', async ({ page }, testInfo) => {
    await open(page, '/', { empty: true });
    await expectNoSeriousViolation(page, testInfo, 'home-empty');
    await open(page, '/units', { empty: true });
    await expectNoSeriousViolation(page, testInfo, 'units-empty');
  });

  test('import CSV: simulation report', async ({ page }, testInfo) => {
    await open(page, '/imports');
    await fillField(page, 'import-text', 'ref,sku,location,already_counted\nIMP-001,UR500-M,Entrepôt Bordeaux,non\nIMP-002,UR500-M,Lieu inconnu,non');
    await page.getByTestId('import-simulate').getByRole('button').click();
    await expect(page.getByTestId('import-report')).toBeVisible();
    await expectNoSeriousViolation(page, testInfo, 'imports-report');
  });
});

test('canary: axe does flag a missing name and a low contrast (the checks above are not vacuous)', async ({ page }) => {
  await open(page, '/');
  await page.evaluate(() => {
    document.querySelector('main')!.insertAdjacentHTML('beforeend', '<button id="canary-a"></button><p id="canary-b" style="color:#bbb;background:#fff">low contrast text</p>');
  });
  const ids = (await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id);
  expect(ids).toEqual(expect.arrayContaining(['button-name', 'color-contrast']));
});
