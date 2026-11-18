/**
 * Keyboard-only paths and focus (spec 15.9 "navigation complète au clavier, ordre de focus logique",
 * T-UX-03 keyboard part) and the designation rule (T-UX-07: Enter never validates an autocomplete suggestion,
 * 15.5: a suggestion is neither clickable nor validated by itself).
 *
 * Shim vs real CDN: the focus ring of Polaris' own controls is drawn by the components; with the offline shim
 * it is drawn by the shim, so that check only applies to the app's own elements (skip link) unless
 * UI_TESTS_REAL_CDN=1.
 */
import { translator } from './messages';
import { expect, focusInfo, fillField, goTo, input, mockState, open, REAL_CDN, tabTo, tabToName, test } from './support';

const t = translator('fr');

test.describe('keyboard: designation of a unit (assign a unit to an order line)', () => {
  async function openDesignation(page: import('@playwright/test').Page, anomaly: string, action: string) {
    await open(page, '/anomalies');
    await tabTo(page, `action-${anomaly}-${action}`);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('designation-input')).toBeVisible();
    await tabTo(page, 'designation-input');
  }
  const status = (page: import('@playwright/test').Page, id: string) => mockState(page, (m) => m.anomalies.find((a: { id: string }) => a.id === 'ANO')?.status as string);

  test('Enter on a suggestion does not validate; the full ref typed then Enter does', async ({ page }) => {
    await openDesignation(page, 'ano-5', 'assign_unit');
    await page.keyboard.type('SN-UR');
    await expect(page.getByTestId('designation-suggestions')).toBeVisible();
    await expect(page.getByTestId('designation-status')).toContainText(t('desig.suggestions', { count: 5 }));

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('designation-message')).toContainText(t('desig.no_match'));
    expect(await mockState(page, (m) => m.anomalies.find((a: { id: string }) => a.id === 'ano-5').status as string)).toBe('open');
    expect(await mockState(page, (m) => m.postLog.filter((p: { name: string }) => p.name === 'resolveAnomaly').length as number)).toBe(0);

    // Suggestions are not part of the keyboard path: Tab never lands on one.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      const info = await focusInfo(page);
      expect(info?.path ?? []).not.toContain('li');
    }

    await input(page, 'designation-input').fill('');
    await tabTo(page, 'designation-input');
    await page.keyboard.type('sn-ur500-m-51203');
    await expect(page.getByTestId('designation-status')).toContainText(t('desig.matched', { ref: 'SN-UR500-M-51203' }));
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('live-region')).toContainText(t('anomalies.resolved_done'));
    expect(await mockState(page, (m) => m.anomalies.find((a: { id: string }) => a.id === 'ano-5').status as string)).toBe('resolved');
  });

  test('the last 4 characters validate a unit when they are unique among the proposed units', async ({ page }) => {
    await openDesignation(page, 'ano-2', 'designate_shipped');
    await page.keyboard.type('1201');
    await expect(page.getByTestId('designation-status')).toContainText(t('desig.matched', { ref: 'SN-UR500-L-61201' }));
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('live-region')).toContainText(t('anomalies.resolved_done'));
    expect(await mockState(page, (m) => m.anomalies.find((a: { id: string }) => a.id === 'ano-2').status as string)).toBe('resolved');
  });

  test('a click on a suggestion designates nothing', async ({ page }) => {
    await open(page, '/anomalies');
    await page.getByTestId('action-ano-5-assign_unit').getByRole('button').click();
    await fillField(page, 'designation-input', 'SN-UR500-M-5120');
    const first = page.getByTestId('designation-suggestions').locator('li').first();
    await expect(first).toBeVisible();
    await first.click();
    await expect(page.getByTestId('designation-input').locator('input')).toHaveValue('SN-UR500-M-5120');
    expect(await mockState(page, (m) => m.postLog.filter((p: { name: string }) => p.name === 'resolveAnomaly').length as number)).toBe(0);
    // Pressing Enter on the same partial text still validates nothing (no unique match).
    await input(page, 'designation-input').press('Enter');
    expect(await mockState(page, (m) => m.postLog.filter((p: { name: string }) => p.name === 'resolveAnomaly').length as number)).toBe(0);
  });
});

test.describe('keyboard: navigation and focus', () => {
  test('the first Tab reaches a visible skip link that moves focus past the navigation', async ({ page }) => {
    await open(page, '/units');
    await page.keyboard.press('Tab');
    const info = await focusInfo(page);
    expect(info?.name).toBe(t('shell.skip'));
    expect(info?.indicator, 'focus indicator on the skip link').toBe(true);
    const box = await page.getByRole('link', { name: t('shell.skip') }).boundingBox();
    expect(box && box.width > 1 && box.height > 1 && box.x >= 0 && box.y >= 0, 'skip link is visible when focused').toBe(true);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    const next = await focusInfo(page);
    expect(next?.path, 'focus continues inside <main> after the skip link').toContain('main');
  });

  test('after a screen change focus moves to the main region (logical focus order)', async ({ page }) => {
    await open(page, '/');
    await goTo(page, t('nav.anomalies'));
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('main');
    await page.keyboard.press('Tab');
    const info = await focusInfo(page);
    expect(info?.path).toContain('main');
  });

  for (const path of ['/', '/units', '/tracked-items', '/anomalies', '/imports', '/settings', '/settings/health', '/start']) {
    test(`Tab walk on ${path}: focus never lost, never trapped, a focus indicator everywhere`, async ({ page }) => {
      await open(page, path);
      const stops: string[] = [];
      let leftPage = false;
      for (let i = 0; i < 120; i++) {
        await page.keyboard.press('Tab');
        const info = await focusInfo(page);
        if (!info) {
          // Focus left the document (browser UI): the page is not a keyboard trap.
          leftPage = true;
          break;
        }
        stops.push(`${info.tag}:${info.name}`);
        if (REAL_CDN || !info.insidePolaris) expect(info.indicator, `no visible focus indicator on ${info.tag} "${info.name}" (${path})`).toBe(true);
      }
      expect(stops.length, `${path} has focusable controls`).toBeGreaterThan(5);
      expect(leftPage, `keyboard trap on ${path}: ${stops.slice(-6).join(' > ')}`).toBe(true);
    });
  }

  test('health: a given-up write is retried from the keyboard, focus stays in the page (12.7)', async ({ page }) => {
    await open(page, '/settings/health?mock_health=stopped');
    await tabTo(page, 'health-retry-write-42');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('health-retry-write-done')).toContainText(t('health.retry.write_done'));
    await expect(page.getByTestId('live-region')).toContainText(t('health.retry.write_done'));
    expect(await mockState(page, (m) => m.postLog.map((p: { name: string }) => p.name) as string[])).toEqual(['retryWrite']);
    // The row left the list with its button: Tab goes on inside the page instead of being lost.
    await page.keyboard.press('Tab');
    expect(await focusInfo(page)).not.toBeNull();
  });

  test('health: a given-up write is abandoned from the keyboard, through its confirmation (12.4)', async ({ page }) => {
    await open(page, '/settings/health?mock_health=stopped');
    await tabTo(page, 'health-abandon-write-42');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('dialog-confirm')).toBeVisible();
    // The dialog takes the focus; Tab stays inside it until the confirmation.
    const inDialog = await focusInfo(page);
    if (!inDialog?.chain.includes('dialog-confirm')) await tabTo(page, 'dialog-confirm', 10);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('health-retry-write-done')).toContainText(t('health.abandon.done'));
    await expect(page.getByTestId('live-region')).toContainText(t('health.abandon.done'));
    expect(await mockState(page, (m) => m.postLog.map((p: { name: string }) => p.name) as string[])).toEqual(['abandonWrite']);
    await page.keyboard.press('Tab');
    expect(await focusInfo(page)).not.toBeNull();
  });

  test('settings users: the owner designates an administrator from the keyboard (15.8)', async ({ page }) => {
    await open(page, '/settings');
    await tabTo(page, 'user-grant-70004', 250);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('dialog-confirm')).toBeVisible();
    const inDialog = await focusInfo(page);
    if (!inDialog?.chain.includes('dialog-confirm')) await tabTo(page, 'dialog-confirm', 10);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('user-revoke-70004')).toBeVisible();
    await expect(page.getByTestId('live-region')).toContainText(t('users.granted', { name: 'Inès' }));
    expect(await mockState(page, (m) => m.appUsers.find((u: { userId: string }) => u.userId === '70004').role as string)).toBe('admin');
  });

  test('global search: a ref typed then Enter opens the unit sheet', async ({ page }) => {
    await open(page, '/');
    await tabTo(page, 'global-search');
    await page.keyboard.type('SN-UR500-M-51203');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/units\/unit-/);
  });

  test('the home screen links are reachable and activated by Enter', async ({ page }) => {
    await open(page, '/');
    await tabToName(page, t('nav.anomalies'));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/anomalies/);
  });
});

test.describe('keyboard: confirmation dialogs (15.7, browser recette)', () => {
  /**
   * In the real admin, Escape did not close the emergency-stop dialog: the Polaris modal does not close
   * itself on Escape there, while the offline shim is a native <dialog> that does (so this suite used to
   * pass for the wrong reason). The native close is switched off here, so only the app's own Escape
   * handling can close the dialog.
   */
  async function withoutNativeEscape(page: import('@playwright/test').Page) {
    await page.evaluate(() => {
      const dialog = document.querySelector('s-modal')?.shadowRoot?.querySelector('dialog');
      dialog?.addEventListener('cancel', (e) => e.preventDefault());
    });
  }

  test('emergency stop: Escape closes the dialog without acting, wherever the focus is inside it, and the focus goes back', async ({ page }) => {
    await open(page, '/settings');
    for (const target of ['dialog-cancel', 'dialog-confirm']) {
      await tabTo(page, 'emergency-toggle', 200);
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('dialog-confirm')).toBeVisible();
      await withoutNativeEscape(page);
      const at = await focusInfo(page);
      if (!at?.chain.includes(target)) await tabTo(page, target, 10);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);
      await expect(page.locator('s-modal')).toHaveCount(0);
      expect(await mockState(page, (m) => m.emergencyStop as boolean)).toBe(false);
      expect(await mockState(page, (m) => m.postLog.length as number)).toBe(0);
      expect((await focusInfo(page))?.chain).toContain('emergency-toggle');
    }
  });

  test('emergency stop: Cancel and a confirmed stop leave no modal shown behind', async ({ page }) => {
    await open(page, '/settings');
    await tabTo(page, 'emergency-toggle', 200);
    await page.keyboard.press('Enter');
    await tabTo(page, 'dialog-cancel', 10);
    await page.keyboard.press('Enter');
    await expect(page.locator('s-modal')).toHaveCount(0);
    expect((await focusInfo(page))?.chain).toContain('emergency-toggle');
    await page.keyboard.press('Enter');
    await tabTo(page, 'dialog-confirm', 10);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('banner-emergency')).toBeVisible();
    await expect(page.locator('s-modal')).toHaveCount(0);
    // Nothing modal is left open in the page: the rest of the page takes clicks again.
    expect(await page.evaluate(() => document.querySelectorAll('dialog[open]').length + [...document.querySelectorAll('*')].filter((e) => e.shadowRoot?.querySelector('dialog[open]')).length)).toBe(0);
    await goTo(page, t('nav.anomalies'));
    await expect(page).toHaveURL(/\/anomalies/);
  });
});
