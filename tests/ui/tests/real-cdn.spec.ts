/**
 * Assertions that only make sense with the real Polaris web components (UI_TESTS_REAL_CDN=1, network access to
 * https://cdn.shopify.com). The other specs also run in that mode and then double as the contract check of
 * app/DECISIONS.md decision 19 (event names and properties of s-text-field, s-select, s-checkbox, s-modal):
 * paste/check/validate, designation and settings flows only pass if the real elements honour that contract.
 *
 * Still NOT covered anywhere here, because it needs a real Shopify admin (App Bridge, embedded iframe,
 * resource picker, save bar, extensions): the admin extensions' blocks, `shopify:admin/...` links, the
 * `shopify:navigate` events of s-app-nav and the contextual save bar of 15.1.
 */
import { expect, open, REAL_CDN, test } from './support';

const TAGS = ['s-page', 's-section', 's-button', 's-link', 's-text-field', 's-text-area', 's-select', 's-checkbox', 's-modal', 's-banner', 's-badge', 's-table', 's-stack', 's-spinner', 's-heading', 's-paragraph', 's-text', 's-box'];

test.describe('@real-cdn real Polaris components', () => {
  test.skip(!REAL_CDN, 'needs UI_TESTS_REAL_CDN=1 and access to https://cdn.shopify.com');

  test('the page runs on the real script, not on the offline shim', async ({ page }) => {
    await open(page, '/');
    expect(await page.evaluate(() => (window as any)['serialis-polaris-shim'] === true)).toBe(false);
  });

  test('every Polaris element used by the app is defined by the CDN script', async ({ page }) => {
    await open(page, '/');
    const missing = await page.evaluate((tags) => tags.filter((t) => !customElements.get(t)), TAGS);
    expect(missing).toEqual([]);
  });
});
