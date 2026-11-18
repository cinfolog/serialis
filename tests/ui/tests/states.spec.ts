/**
 * T-UX-05 (spec 15.10): every screen shows its empty, loading, error, conflict, offline and read-only states,
 * and has no horizontal scrolling at 375 px width (15.9). The text completeness in French and English is in
 * i18n.spec.ts. Component-level states are also covered by the Vitest tests of the app.
 *
 * Shim vs real CDN: the 375 px check measures the real layout only with UI_TESTS_REAL_CDN=1 (Polaris tables
 * turn into cards below 600 px); with the shim it measures the app's own markup on a simplified layout.
 */
import type { Page } from '@playwright/test';
import { translator } from './messages';
import { expect, goTo, open, ready, scenarioQuery, test } from './support';

const t = translator('fr');

const SCREENS = [
  { name: 'home', path: '/' },
  { name: 'units', path: '/units' },
  { name: 'tracked-items', path: '/tracked-items' },
  { name: 'anomalies', path: '/anomalies' },
  { name: 'imports', path: '/imports' },
  { name: 'settings', path: '/settings' },
  { name: 'settings-health', path: '/settings/health?mock_health=degraded' },
  { name: 'settings-health-stopped', path: '/settings/health?mock_health=stopped' },
  { name: 'settings-designated-admin', path: '/settings?mock_role=admin' },
  { name: 'wizard', path: '/start' },
];

test.describe('T-UX-05 no horizontal scrolling at 375 px', () => {
  test.use({ viewport: { width: 375, height: 800 } });
  for (const locale of ['fr', 'en'] as const) {
    for (const screen of SCREENS) {
      test(`${screen.name} [${locale}]`, async ({ page }) => {
        await open(page, screen.path, { locale });
        const overflow = await page.evaluate(() => {
          const doc = document.documentElement;
          const offenders: string[] = [];
          const visit = (root: ParentNode) => {
            for (const el of Array.from(root.querySelectorAll('*'))) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.right > doc.clientWidth + 1) offenders.push(`${el.localName}${(el as HTMLElement).dataset['testid'] ? `[${(el as HTMLElement).dataset['testid']}]` : ''} right=${Math.round(r.right)}`);
              if ((el as HTMLElement).shadowRoot) visit((el as HTMLElement).shadowRoot!);
            }
          };
          visit(document);
          return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, offenders: offenders.slice(0, 8) };
        });
        expect(overflow.scrollWidth, `horizontal scroll: ${overflow.offenders.join(', ')}`).toBeLessThanOrEqual(overflow.clientWidth);
      });
    }
  }
});

test.describe('T-UX-05 states', () => {
  test('empty: a new shop shows the start card on home and an empty state on the lists', async ({ page }) => {
    await open(page, '/', { empty: true });
    await expect(page.getByTestId('start-step')).toBeVisible();
    for (const [path, label] of [
      ['/units', 'nav.units'],
      ['/tracked-items', 'nav.tracked'],
      ['/anomalies', 'nav.anomalies'],
    ] as const) {
      await goTo(page, t(label));
      await expect(page.getByTestId('empty-state'), path).toBeVisible();
    }
  });

  test('loading: a spinner with an accessible name, then "Encore un instant" after 3 s', async ({ page }) => {
    await page.goto(`/units?${scenarioQuery({ delay: 5000 })}`);
    const loading = page.getByTestId('loading');
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('role', 'status');
    await expect(loading).toContainText(t('common.loading'));
    await expect(loading).toContainText(t('common.still_loading'), { timeout: 8_000 });
  });

  test('error: a clear message with a retry that recovers', async ({ page }) => {
    await open(page, '/');
    await page.evaluate(() => {
      const m = (window as any).__serialisMock;
      m.__listAnomalies = m.listAnomalies;
      m.listAnomalies = async () => {
        throw new Error('boom');
      };
    });
    await goTo(page, t('nav.anomalies'));
    const error = page.getByTestId('error-state');
    await expect(error).toContainText(t('common.error_title'));
    await expect(error).toContainText(t('error.unknown'));
    await page.evaluate(() => {
      const m = (window as any).__serialisMock;
      m.listAnomalies = m.__listAnomalies;
    });
    await error.getByRole('button', { name: t('common.retry') }).click();
    await expect(page.getByTestId('error-state')).toHaveCount(0);
    await expect(page.getByTestId('action-ano-5-assign_unit')).toBeVisible();
  });

  test('conflict: a refused resolution says what happened and keeps the work', async ({ page }) => {
    await open(page, '/anomalies');
    await page.evaluate(async () => {
      const m = (window as any).__serialisMock;
      // ApiError is not exported to the page: borrow its constructor from a real refusal.
      const ApiError = (await m.resolveAnomaly('missing', { action: 'x' }).catch((e: Error) => e)).constructor;
      m.resolveAnomaly = async () => {
        throw new ApiError({ status: 409, code: 'precondition_failed', detail: 'L’anomalie a changé.' });
      };
    });
    await page.getByTestId('action-ano-4-register_units').getByRole('button').click();
    await page.getByTestId('dialog-confirm').getByRole('button').click();
    const error = page.getByTestId('anomaly-error-ano-4');
    await expect(error).toContainText(t('error.precondition_failed'));
    await expect(page.getByTestId('action-ano-4-register_units')).toBeVisible();
  });

  test('offline: a banner, writes blocked, typed input kept', async ({ page, context }) => {
    await open(page, '/units?add=1');
    await page.getByTestId('refs-text').locator('textarea').fill('NEW-0001');
    await context.setOffline(true);
    await expect(page.getByTestId('banner-offline')).toContainText(t('common.offline'));
    await expect(page.getByTestId('refs-check').getByRole('button')).toBeDisabled();
    await expect(page.getByTestId('refs-text').locator('textarea')).toHaveValue('NEW-0001');
    await context.setOffline(false);
    await expect(page.getByTestId('banner-offline')).toHaveCount(0);
    await expect(page.getByTestId('refs-check').getByRole('button')).toBeEnabled();
  });

  test('emergency stop: permanent banner on every screen with a way to resume', async ({ page }) => {
    await open(page, '/', { stop: true });
    for (const label of ['nav.home', 'nav.units', 'nav.settings']) {
      await goTo(page, t(label));
      await expect(page.getByTestId('banner-emergency')).toBeVisible();
    }
    await expect(page.getByTestId('resume-open')).toBeVisible();
  });

  test('read-only: an operator sees settings and tracked items without the write actions', async ({ page }: { page: Page }) => {
    await open(page, '/settings', { role: 'operator' });
    await expect(page.getByTestId('settings-read-only')).toContainText(t('settings.read_only'));
    await goTo(page, t('nav.tracked'));
    await ready(page);
    // Activation is reserved to administrators (14.1): the action is not offered, the list stays readable.
    await expect(page.getByTestId('tracked-activate')).toHaveCount(0);
    await expect(page.getByTestId('tracked-table')).toBeVisible();
  });
});
