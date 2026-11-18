/**
 * T-UX-02 (spec 15.10): adding refs. Paste of 50 refs of which 3 are in error (duplicate, format, already
 * known), from paste to validation in under a minute; the 3 errors are flagged on their own line and the 47
 * others are validated; a validation sent again after a cut is not applied twice.
 *
 * Covered here: the admin app screen (Units, and the startup wizard uses the same panel). The variant block
 * of the admin extension (MVP) and the Arrivage screen (lot 1) need a real Shopify admin: not covered here.
 */
import { translator } from './messages';
import { expect, fillField, mockState, open, press, tabTo, test } from './support';

const t = translator('fr');

const GOOD = Array.from({ length: 47 }, (_, i) => `NEW-UR500-${String(i + 1).padStart(4, '0')}`);
// 3 errors: a duplicate in the list, an invalid format, a ref already registered in the shop.
const ERRORS = ['NEW-UR500-0001', 'NEW@@@', 'SN-UR500-M-51200'];
const PASTE = [...GOOD.slice(0, 20), ERRORS[0], ...GOOD.slice(20, 40), ERRORS[1], ...GOOD.slice(40), ERRORS[2]].join('\n');

async function checkPasted(page: import('@playwright/test').Page) {
  await fillField(page, 'refs-text', PASTE);
  await press(page, 'refs-check');
  await expect(page.getByTestId('refs-summary')).toHaveText(t('refs.summary', { ready: 47, total: 50 }));
}

test.describe('T-UX-02 adding refs', () => {
  test('50 pasted refs, 3 flagged on their line, 47 validated, in under a minute', async ({ page }) => {
    await open(page, '/units?add=1');
    const before = await mockState(page, (m) => m.units.length as number);
    const started = Date.now();
    await checkPasted(page);

    const rows = page.getByTestId('refs-check-table').getByRole('row');
    // 1 header row + 50 lines
    await expect(rows).toHaveCount(51);
    for (const [ref, status] of [
      ['NEW@@@', 'invalid_format'],
      ['SN-UR500-M-51200', 'already_known'],
    ] as const) {
      await expect(rows.filter({ hasText: ref })).toContainText(t(`refs.status.${status}`));
    }
    // The duplicate is the second occurrence only: the first stays "ready".
    await expect(rows.filter({ hasText: 'NEW-UR500-0001' }).nth(0)).toContainText(t('refs.status.ready'));
    await expect(rows.filter({ hasText: 'NEW-UR500-0001' }).nth(1)).toContainText(t('refs.status.duplicate_in_list'));
    await expect(page.getByTestId('refs-effect')).toBeVisible();

    await press(page, 'refs-submit');
    await expect(page.getByTestId('dialog-confirm')).toBeVisible();
    await press(page, 'dialog-confirm');
    await expect(page.getByTestId('refs-result')).toContainText(t('refs.done', { count: 47 }));
    expect(Date.now() - started, 'paste to validation').toBeLessThan(60_000);

    expect(await mockState(page, (m) => m.units.length as number)).toBe(before + 47);
    // Live announcement for screen readers (15.9).
    await expect(page.getByTestId('live-region')).toContainText(/47/);
  });

  test('a validation sent again after a cut is not applied twice', async ({ page }) => {
    await open(page, '/units?add=1');
    const before = await mockState(page, (m) => m.units.length as number);
    // The server applies the request but the answer is lost (connection cut) the first time.
    await page.evaluate(() => {
      const m = (window as any).__serialisMock;
      const original = m.createUnitsBatch.bind(m);
      let cut = true;
      m.createUnitsBatch = async (...args: unknown[]) => {
        const response = await original(...args);
        if (cut) {
          cut = false;
          throw new Error('network cut');
        }
        return response;
      };
    });
    await checkPasted(page);
    await press(page, 'refs-submit');
    await press(page, 'dialog-confirm');
    await expect(page.getByTestId('refs-error')).toBeVisible();
    // The user presses "Valider" again: same input, same idempotency key.
    await press(page, 'refs-submit');
    await press(page, 'dialog-confirm');
    await expect(page.getByTestId('refs-result')).toContainText(t('refs.done', { count: 47 }));

    const log = await mockState(page, (m) => m.postLog.filter((p: { name: string }) => p.name === 'createUnitsBatch') as Array<{ key: string }>);
    expect(log).toHaveLength(2);
    expect(log[1]?.key).toBe(log[0]?.key);
    expect(await mockState(page, (m) => m.units.length as number)).toBe(before + 47);
  });

  test('editing the list after the check invalidates it (no stale validation)', async ({ page }) => {
    await open(page, '/units?add=1');
    await checkPasted(page);
    await fillField(page, 'refs-text', `${PASTE}\nNEW-UR500-9999`);
    await expect(page.getByTestId('refs-summary')).toHaveCount(0);
    await expect(page.getByTestId('refs-submit')).toHaveCount(0);
  });

  test('keyboard only: paste, check, validate (same result as with the mouse)', async ({ page }) => {
    await open(page, '/units?add=1');
    const before = await mockState(page, (m) => m.units.length as number);
    await tabTo(page, 'refs-text');
    await page.keyboard.insertText(PASTE);
    await tabTo(page, 'refs-check');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('refs-summary')).toHaveText(t('refs.summary', { ready: 47, total: 50 }));
    await tabTo(page, 'refs-submit');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('dialog-confirm')).toBeVisible();
    await tabTo(page, 'dialog-confirm');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('refs-result')).toContainText(t('refs.done', { count: 47 }));
    expect(await mockState(page, (m) => m.units.length as number)).toBe(before + 47);
  });

  test('the confirmation dialog keeps keyboard focus inside and Escape cancels without writing', async ({ page }) => {
    await open(page, '/units?add=1');
    const before = await mockState(page, (m) => m.units.length as number);
    await checkPasted(page);
    await press(page, 'refs-submit');
    await expect(page.getByTestId('dialog-confirm')).toBeVisible();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        let a: Element | null = document.activeElement;
        while (a && (a as HTMLElement).shadowRoot?.activeElement) a = (a as HTMLElement).shadowRoot!.activeElement;
        const ids: string[] = [];
        for (let n: Node | null = a; n; n = (n as Element).parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null)) if (n instanceof HTMLElement && n.dataset['testid']) ids.push(n.dataset['testid']);
        return ids;
      });
      // Focus is either in the dialog or outside the page (browser UI), never on the page behind.
      expect(info.length === 0 || info.some((id) => id.startsWith('dialog-')), `Tab ${i + 1} left the dialog: ${info.join(',')}`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);
    expect(await mockState(page, (m) => m.units.length as number)).toBe(before);
    // Back on the page, the work is still there and can be validated.
    await expect(page.getByTestId('refs-submit')).toBeVisible();
  });
});
