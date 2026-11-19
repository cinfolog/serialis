/**
 * Confirmation dialogs leave the Shopify admin usable after every close (browser recettes 1.6b, decisions
 * 33, 34 and 42).
 *
 * In the real admin, closing any dialog left the admin top bar and menu greyed until a reload. The shim
 * models that admin layer for `s-modal` (`window.__adminScrim`: layer addressed by id, released only by a
 * hide that completes while the element is in the document). The app now draws its confirmations inside
 * its own frame (native `<dialog>`), so after every path: no admin layer was ever requested, no dialog is
 * left open, the diagnostics (`window.__serialisDialogs`) agree, the safety net had nothing to repair, and
 * the page takes clicks again. This runs on real Chromium: the native dialog under test is the real one.
 */
import type { Page } from '@playwright/test';
import { translator } from './messages';
import { expect, fillField, focusInfo, goTo, mockState, open, press, tabTo, test } from './support';

const t = translator('fr');

/** DIALOG_CHECK_MS of app/src/ui/components.tsx, plus a margin. */
const SAFETY_NET_WAIT_MS = 400;

interface FrameState {
  scrim: { greyed: boolean; orphaned: number; showRequests: number };
  listed: number;
  warnings: number;
  closeReasons: string[];
  openDialogs: number;
  modal: number;
  sModals: number;
}

function frameState(page: Page): Promise<FrameState> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __adminScrim: FrameState['scrim'];
      __serialisDialogs: { open: unknown[]; warnings: number; log: Array<{ type: string; reason?: string }> };
    };
    const shadowOpen = [...document.querySelectorAll('*')].filter((e) => e.shadowRoot?.querySelector('dialog[open]')).length;
    return {
      scrim: w.__adminScrim,
      listed: w.__serialisDialogs.open.length,
      warnings: w.__serialisDialogs.warnings,
      closeReasons: w.__serialisDialogs.log.filter((e) => e.type === 'close').map((e) => e.reason ?? ''),
      openDialogs: document.querySelectorAll('dialog[open]').length + shadowOpen,
      modal: document.querySelectorAll(':modal').length,
      sModals: document.querySelectorAll('s-modal').length,
    };
  });
}

async function expectOpen(page: Page) {
  await expect(page.getByTestId('dialog-confirm')).toBeVisible();
  const s = await frameState(page);
  expect(s.listed).toBe(1);
  expect(s.modal).toBe(1);
}

/** Every check after a close; the admin chrome first (the defect of the recettes). */
async function expectClosed(page: Page, reason?: string) {
  await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);
  let s = await frameState(page);
  expect(s.scrim.greyed, 'the admin top bar and menu stay greyed').toBe(false);
  expect(s.scrim.showRequests, 'an s-modal asked the admin for its layer').toBe(0);
  expect(s.sModals).toBe(0);
  expect(s.openDialogs).toBe(0);
  expect(s.modal).toBe(0);
  expect(s.listed).toBe(0);
  if (reason) expect(s.closeReasons.at(-1)).toBe(reason);
  await page.waitForTimeout(SAFETY_NET_WAIT_MS);
  s = await frameState(page);
  expect(s.warnings, 'the safety net had to close a dialog').toBe(0);
  expect(s.scrim.greyed).toBe(false);
}

/** The page behind takes pointer clicks again (no backdrop, nothing inert left). */
async function expectPageClickable(page: Page) {
  await goTo(page, t('nav.anomalies'));
  await expect(page).toHaveURL(/\/anomalies/);
}

async function openEmergency(page: Page) {
  await page.getByTestId('emergency-toggle').getByRole('button').click();
  await expectOpen(page);
}

test.describe('confirmation dialogs: every close path leaves the admin usable (1.6b)', () => {
  test('emergency stop: Cancel, close button, Escape with the focus on each button, then confirm on and off', async ({ page }) => {
    await open(page, '/settings');

    await openEmergency(page);
    await press(page, 'dialog-cancel');
    await expectClosed(page, 'cancel');
    expect((await focusInfo(page))?.chain).toContain('emergency-toggle');

    await openEmergency(page);
    await expect(page.getByTestId('dialog-close')).toHaveAccessibleName(t('common.close'));
    await page.getByTestId('dialog-close').click();
    await expectClosed(page, 'close-button');

    for (const target of ['dialog-close', 'dialog-cancel', 'dialog-confirm']) {
      await openEmergency(page);
      const at = await focusInfo(page);
      if (!at?.chain.includes(target)) await tabTo(page, target, 10);
      await page.keyboard.press('Escape');
      await expectClosed(page, 'escape');
      expect((await focusInfo(page))?.chain).toContain('emergency-toggle');
    }
    expect(await mockState(page, (m) => m.postLog.length as number)).toBe(0);

    await openEmergency(page);
    await press(page, 'dialog-confirm');
    await expect(page.getByTestId('banner-emergency')).toBeVisible();
    await expectClosed(page, 'program');
    expect(await mockState(page, (m) => m.emergencyStop as boolean)).toBe(true);

    await openEmergency(page);
    await press(page, 'dialog-confirm');
    await expect(page.getByTestId('banner-emergency')).toHaveCount(0);
    await expectClosed(page);
    expect(await mockState(page, (m) => m.emergencyStop as boolean)).toBe(false);
    await expectPageClickable(page);
  });

  test('emergency stop off from the banner: banner and dialog leave the page together', async ({ page }) => {
    await open(page, '/', { stop: true });
    await press(page, 'resume-open');
    await expectOpen(page);
    await press(page, 'dialog-confirm');
    await expect(page.getByTestId('banner-emergency')).toHaveCount(0);
    await expectClosed(page);
    // The trigger left with the banner: the focus is not lost, it goes to the main region.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('main');
    await expectPageClickable(page);
  });

  test('API key: revoke cancelled, then confirmed', async ({ page }) => {
    await open(page, '/settings');
    await fillField(page, 'api-key-name', 'Connecteur');
    await press(page, 'api-key-create');
    await press(page, 'api-key-done');
    const prefix = await mockState(page, (m) => m.apiKeys[0].prefix as string);
    await press(page, `api-key-revoke-${prefix}`);
    await expectOpen(page);
    await press(page, 'dialog-cancel');
    await expectClosed(page, 'cancel');
    await press(page, `api-key-revoke-${prefix}`);
    await expectOpen(page);
    await press(page, 'dialog-confirm');
    await expect(page.getByTestId(`api-key-revoke-${prefix}`)).toHaveCount(0);
    await expectClosed(page);
    await expectPageClickable(page);
  });

  test('import: confirmation after the simulation', async ({ page }) => {
    await open(page, '/imports');
    await fillField(page, 'import-text', 'ref,sku,location,already_counted\nSN-UR500-M-52001,UR500-M,Entrepôt Bordeaux,non');
    await press(page, 'import-simulate');
    await press(page, 'import-confirm');
    await expectOpen(page);
    await press(page, 'dialog-confirm');
    await expect(page.getByTestId('import-done')).toBeVisible();
    await expectClosed(page);
    await expectPageClickable(page);
  });

  test('health: abandon cancelled then confirmed; a retry opens no dialog', async ({ page }) => {
    await open(page, '/settings/health?mock_health=stopped');
    await press(page, 'health-abandon-write-42');
    await expectOpen(page);
    await page.keyboard.press('Escape');
    await expectClosed(page, 'escape');
    await press(page, 'health-abandon-write-42');
    await expectOpen(page);
    await press(page, 'dialog-confirm');
    await expect(page.getByTestId('health-retry-write-done')).toContainText(t('health.abandon.done'));
    await expectClosed(page);
    const revive = page.locator('[data-testid^="health-revive-task-"]').first();
    await revive.getByRole('button').click();
    await expect.poll(() => mockState(page, (m) => m.postLog.length as number)).toBe(2);
    await expect(page.getByTestId('dialog-root')).toHaveCount(0);
    expect((await frameState(page)).scrim.showRequests).toBe(0);
    await expectPageClickable(page);
  });

  test('users: designate an administrator, then withdraw the right', async ({ page }) => {
    await open(page, '/settings');
    await press(page, 'user-grant-70004');
    await expectOpen(page);
    await press(page, 'dialog-confirm');
    await expect(page.getByTestId('user-revoke-70004')).toBeVisible();
    await expectClosed(page);
    await press(page, 'user-revoke-70004');
    await expectOpen(page);
    await press(page, 'dialog-confirm');
    await expect(page.getByTestId('user-grant-70004')).toBeVisible();
    await expectClosed(page);
    await expectPageClickable(page);
  });

  test('admin navigation while a dialog is open: the dialog leaves with its screen', async ({ page }) => {
    await open(page, '/settings');
    await openEmergency(page);
    // What App Bridge reports when the merchant uses the app menu of the admin (outside the frame).
    await page.evaluate(() => {
      const a = document.createElement('a');
      a.setAttribute('href', '/anomalies');
      document.body.append(a);
      a.dispatchEvent(new Event('shopify:navigate', { bubbles: true }));
      a.remove();
    });
    await expect(page).toHaveURL(/\/anomalies/);
    await expectClosed(page, 'unmount');
    await goTo(page, t('nav.units'));
    await expect(page).toHaveURL(/\/units/);
  });

  test('Tab and Shift+Tab stay inside the dialog, nothing behind it takes a click', async ({ page }) => {
    await open(page, '/settings');
    await openEmergency(page);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      expect((await focusInfo(page))?.chain.some((id) => id.startsWith('dialog-')), `Tab ${i + 1}`).toBe(true);
    }
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Shift+Tab');
      expect((await focusInfo(page))?.chain.some((id) => id.startsWith('dialog-')), `Shift+Tab ${i + 1}`).toBe(true);
    }
    // The page behind is inert while the dialog is open (native modal dialog).
    expect(await page.evaluate(() => {
      const link = document.querySelector('nav a, nav s-link');
      if (!link) return 'no-link';
      const r = link.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit?.closest('dialog') ? 'dialog' : hit === document.documentElement || hit === document.body ? 'backdrop' : hit?.closest('nav') ? 'nav' : 'other';
    })).not.toBe('nav');
    await press(page, 'dialog-cancel');
    await expectClosed(page, 'cancel');
  });
});
