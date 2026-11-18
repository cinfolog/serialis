/**
 * T-UX-07 (spec 15.10), browser part: no view displays customer data, no view uses the camera, and the Enter
 * key never validates an autocomplete suggestion (the latter is in keyboard.spec.ts, with the keyboard-only
 * designation path). The static part (every manual transition and every resolution of the catalogue 12.7 has an
 * entry in ui-entry-points.ts) is a source-level test, not a browser one.
 */
import { expect, goTo, mockState, open, test, visibleText } from './support';
import { translator } from './messages';

const t = translator('fr');
const SCREENS = ['/', '/units', '/tracked-items', '/anomalies', '/imports', '/settings', '/settings/health', '/start'];

test.describe('T-UX-07 guard rails in the browser', () => {
  test('no view uses the camera, shows customer data, or calls a third party', async ({ page, diagnostics }) => {
    for (const path of SCREENS) {
      await open(page, path);
      const text = await visibleText(page);
      expect(text, `email address on ${path}`).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(text, `phone number on ${path}`).not.toMatch(/(?:\+33|\b0)\s?[1-9](?:[\s.-]?\d{2}){4}\b/);
      expect(await page.locator('input[capture], input[type="file"][capture], video').count(), `camera input on ${path}`).toBe(0);
      expect(await page.evaluate(() => document.body.innerHTML.match(/customer(Name|Email)|shippingAddress|billingAddress|phoneNumber/i)?.[0] ?? null), `customer field on ${path}`).toBeNull();
    }
    // A unit sheet and the order link: number and link only, never customer data (P8).
    const id = await mockState(page, (m) => m.units.find((u: { orderGid: string | null }) => u.orderGid).id as string);
    await page.goto(`/units/${id}?mock_delay=0`);
    await expect(page.getByTestId('unit-events')).toBeVisible();
    const sheet = await visibleText(page);
    expect(sheet).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(diagnostics.cameraCalls, 'getUserMedia calls').toBe(0);
    expect(diagnostics.externalRequests, 'requests to third-party hosts').toEqual([]);
  });

  test('no console error or uncaught exception while crossing the screens', async ({ page, diagnostics }) => {
    await open(page, '/');
    for (const label of ['nav.units', 'nav.tracked', 'nav.anomalies', 'nav.imports', 'nav.settings', 'nav.home']) await goTo(page, t(label));
    expect(diagnostics.pageErrors).toEqual([]);
    expect(diagnostics.consoleErrors.filter((m) => !/Failed to load resource/.test(m))).toEqual([]);
  });
});
