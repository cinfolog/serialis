/**
 * Performance smoke (spec 15.9, T-UX-06 laboratory part). This is a smoke test on the mock build, not the
 * Built for Shopify measurement (which Shopify takes on real calls, 75th percentile).
 *
 *  - Bundle budget: 15.9 defines no bundle size, so a budget is recorded here (see BUDGET_*): the entry JS of the
 *    admin app, gzipped, measured at about 116 KiB when this test was written, budget 150 KiB (about 30 % headroom).
 *    The mock chunk is lazy and absent from the production bundle: it is excluded.
 *  - Web Vitals thresholds of 15.9 on the home screen: LCP <= 2.5 s, CLS <= 0.1 (INP needs real interactions).
 *  - "Réponse à une désignation ou à une suggestion en moins de 500 ms au 95e centile": 30 suggestion
 *    refreshes measured in the page (from the input event to the suggestions in the DOM), p95 < 500 ms.
 *
 * Shim vs real CDN: with the shim, load timings do not include the download and execution of polaris.js:
 * the Web Vitals check is only meaningful with UI_TESTS_REAL_CDN=1 and is skipped otherwise.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { expect, open, REAL_CDN, test } from './support';

const DIST = fileURLToPath(new URL('../../../app/dist', import.meta.url));
const KB = 1024;
const BUDGET_ENTRY_JS_GZIP = 150 * KB;
const BUDGET_CSS_GZIP = 20 * KB;
const BUDGET_REQUESTS = 6;

const gz = (file: string) => gzipSync(readFileSync(`${DIST}/${file}`)).length;

test.describe('performance smoke', () => {
  test('bundle budget of the admin app', () => {
    const assets = readdirSync(`${DIST}/assets`).filter((f) => !f.endsWith('.map'));
    const html = readFileSync(`${DIST}/index.html`, 'utf8');
    const entry = assets.filter((f) => f.endsWith('.js') && !/^mock-/.test(f) && html.includes(f));
    expect(entry.length, 'entry chunk found in index.html').toBeGreaterThan(0);
    const js = entry.reduce((sum, f) => sum + gz(`assets/${f}`), 0);
    const css = assets.filter((f) => f.endsWith('.css')).reduce((sum, f) => sum + gz(`assets/${f}`), 0);
    console.log(`entry JS ${(js / KB).toFixed(1)} KB gzip, CSS ${(css / KB).toFixed(1)} KB gzip, ${assets.length} asset files`);
    expect(js, `entry JS gzip (budget ${BUDGET_ENTRY_JS_GZIP / KB} KB)`).toBeLessThanOrEqual(BUDGET_ENTRY_JS_GZIP);
    expect(css, `CSS gzip (budget ${BUDGET_CSS_GZIP / KB} KB)`).toBeLessThanOrEqual(BUDGET_CSS_GZIP);
    // Nothing but the Polaris script is loaded from outside, and nothing heavier than Polaris is added.
    const external = [...html.matchAll(/<script[^>]+src="(https?:[^"]+)"/g)].map((m) => m[1]);
    expect(external.filter((u) => !u!.startsWith('https://cdn.shopify.com/'))).toEqual([]);
  });

  test('a cold load of the home screen makes few requests', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).hostname !== 'cdn.shopify.com') requests.push(new URL(r.url()).pathname);
    });
    await open(page, '/');
    // index.html, entry JS, lazy mock chunk (mock build only), favicon request excluded.
    expect(requests.filter((p) => !p.endsWith('favicon.ico')).length, requests.join(' ')).toBeLessThanOrEqual(BUDGET_REQUESTS);
  });

  test('suggestions refresh in under 500 ms (p95)', async ({ page }) => {
    await open(page, '/anomalies');
    await page.getByTestId('action-ano-5-assign_unit').getByRole('button').click();
    await expect(page.getByTestId('designation-input')).toBeVisible();
    const samples = await page.evaluate(async () => {
      const host = document.querySelector('[data-testid="designation-input"]') as HTMLElement & { shadowRoot: ShadowRoot };
      const field = host.shadowRoot.querySelector('input') as HTMLInputElement;
      const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
      const type = async (value: string) => {
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        const t0 = performance.now();
        while (!document.querySelector('[data-testid="designation-suggestions"]')) {
          if (performance.now() - t0 > 2000) return 2000;
          await frame();
        }
        return performance.now() - t0;
      };
      const out: number[] = [];
      for (let i = 0; i < 30; i++) {
        out.push(await type(i % 2 ? 'SN-UR5' : 'SN-UR'));
        field.value = '';
        field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        await frame();
      }
      return out;
    });
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    console.log(`suggestion refresh p95 ${p95.toFixed(0)} ms (max ${sorted.at(-1)!.toFixed(0)} ms)`);
    expect(p95).toBeLessThan(500);
  });

  test('home screen Web Vitals within the Built for Shopify thresholds @real-cdn', async ({ page }) => {
    test.skip(!REAL_CDN, 'needs the real Polaris script (UI_TESTS_REAL_CDN=1): load timings with the shim are not representative');
    await page.addInitScript(() => {
      const w = window as unknown as { __lcp: number; __cls: number };
      w.__lcp = 0;
      w.__cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__lcp = e.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) w.__cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await open(page, '/', { delay: 120 });
    await page.waitForTimeout(1500);
    const { lcp, cls } = await page.evaluate(() => ({ lcp: (window as any).__lcp as number, cls: (window as any).__cls as number }));
    console.log(`LCP ${lcp.toFixed(0)} ms, CLS ${cls.toFixed(3)}`);
    expect(lcp).toBeGreaterThan(0);
    expect(lcp).toBeLessThanOrEqual(2500);
    expect(cls).toBeLessThanOrEqual(0.1);
  });
});
