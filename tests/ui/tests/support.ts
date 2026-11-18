import AxeBuilder from '@axe-core/playwright';
import { expect, test as base, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * UI_TESTS_REAL_CDN=1: load the real Polaris web components from https://cdn.shopify.com (needs network).
 * Default: the CDN script is intercepted and replaced by fixtures/polaris-shim.js (deterministic, offline).
 */
export const REAL_CDN = process.env['UI_TESTS_REAL_CDN'] === '1';

const shim = readFileSync(fileURLToPath(new URL('../fixtures/polaris-shim.js', import.meta.url)), 'utf8');

export interface Diagnostics {
  consoleErrors: string[];
  pageErrors: string[];
  externalRequests: string[];
  cameraCalls: number;
}

export const test = base.extend<{ diagnostics: Diagnostics }>({
  diagnostics: [
    async ({ page }, use) => {
      const diagnostics: Diagnostics = { consoleErrors: [], pageErrors: [], externalRequests: [], cameraCalls: 0 };
      page.on('console', (m) => {
        if (m.type() === 'error') diagnostics.consoleErrors.push(m.text());
      });
      page.on('pageerror', (e) => diagnostics.pageErrors.push(e.message));
      await page.exposeFunction('__reportCamera', () => {
        diagnostics.cameraCalls += 1;
      });
      // T-UX-07: no view uses the camera. Any attempt to open a media stream is recorded.
      await page.addInitScript(() => {
        const report = () => void (window as unknown as { __reportCamera: () => void }).__reportCamera();
        const md = navigator.mediaDevices;
        if (md) md.getUserMedia = () => (report(), Promise.reject(new DOMException('blocked by test', 'NotAllowedError')));
      });
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
        if (url.hostname === 'cdn.shopify.com') {
          if (REAL_CDN) return route.continue();
          if (url.pathname.endsWith('/polaris.js')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: shim });
          return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
        }
        diagnostics.externalRequests.push(url.href);
        return route.abort();
      });
      await use(diagnostics);
    },
    { auto: true },
  ],
});

export { expect };

export interface Scenario {
  locale?: 'fr' | 'en';
  empty?: boolean;
  /** `operator`, or `admin` = an administrator designated by the owner (default: the owner). */
  role?: 'operator' | 'admin';
  stop?: boolean;
  shown?: boolean;
  delay?: number;
}

export function scenarioQuery(s: Scenario = {}): string {
  const p = new URLSearchParams({ mock_delay: String(s.delay ?? 0) });
  if (s.locale === 'en') p.set('mock_locale', 'en');
  if (s.empty) p.set('mock_empty', '1');
  if (s.role) p.set('mock_role', s.role);
  if (s.stop) p.set('mock_stop', '1');
  if (s.shown) p.set('mock_shown', '1');
  return p.toString();
}

/** Opens a route of the app on the mock backend and waits for the first screen (no loading state left). */
export async function open(page: Page, path: string, scenario: Scenario = {}): Promise<void> {
  const sep = path.includes('?') ? '&' : '?';
  await page.goto(`${path}${sep}${scenarioQuery(scenario)}`);
  await ready(page);
}

export async function ready(page: Page): Promise<void> {
  await page.locator('s-page').first().waitFor({ state: 'attached' });
  await expect(page.getByTestId('loading')).toHaveCount(0);
}

/** Client-side navigation through the in-page nav bar (keeps the mock state of the page). */
export async function goTo(page: Page, label: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Serialis' }).getByRole('link', { name: label, exact: true }).click();
  await ready(page);
}

export async function mockState<T>(page: Page, fn: (mock: any) => T): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__serialisMock)`) as Promise<T>;
}

// -- inputs (work with the shim and with the real components: both render native controls) ---------------

export const input = (page: Page, testId: string): Locator => page.getByTestId(testId).locator('input, textarea, select').first();

export async function fillField(page: Page, testId: string, value: string): Promise<void> {
  await input(page, testId).fill(value);
}

// -- accessibility ---------------------------------------------------------------------------------------

export async function expectNoSeriousViolation(page: Page, testInfo: TestInfo, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const summary = blocking.map((v) => `${v.id} [${v.impact}] ${v.help} (${v.nodes.length}) -> ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  if (summary.length > 0) {
    await testInfo.attach(`axe-${label}.json`, { body: JSON.stringify(blocking, null, 2), contentType: 'application/json' });
    for (const line of summary) console.log(`::error title=axe ${label}::${line}`);
  }
  const minor = results.violations.filter((v) => v.impact !== 'serious' && v.impact !== 'critical');
  if (minor.length > 0) await testInfo.attach(`axe-minor-${label}.json`, { body: JSON.stringify(minor.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })), null, 2), contentType: 'application/json' });
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

// -- keyboard --------------------------------------------------------------------------------------------

export interface FocusInfo {
  tag: string;
  chain: string[];
  insidePolaris: boolean;
  /** Local names of the composed ancestors (through shadow roots), e.g. ['button', 's-button', 'main', ...]. */
  path: string[];
  name: string;
  indicator: boolean;
}

/** Deepest focused element (through shadow roots), the `data-testid`s of its ancestors, and whether a focus ring is drawn. */
export async function focusInfo(page: Page): Promise<FocusInfo | null> {
  return page.evaluate(() => {
    let active: Element | null = document.activeElement;
    while (active && (active as HTMLElement).shadowRoot?.activeElement) active = (active as HTMLElement).shadowRoot!.activeElement;
    if (!active || active === document.body || active === document.documentElement) return null;
    const chain: string[] = [];
    let insidePolaris = false;
    const path: string[] = [];
    let node: Node | null = active;
    while (node) {
      if (node instanceof HTMLElement) {
        path.push(node.localName);
        if (node.dataset['testid']) chain.push(node.dataset['testid']);
        if (node.localName.startsWith('s-')) insidePolaris = true;
      }
      node = (node as Element).parentElement ?? ((node.getRootNode() as ShadowRoot).host ?? null);
    }
    const cs = getComputedStyle(active);
    const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
    const shadow = cs.boxShadow !== 'none' && cs.boxShadow !== '';
    const el = active as HTMLElement;
    const host = (el.getRootNode() as ShadowRoot).host as HTMLElement | undefined;
    const name = (el.getAttribute('aria-label') || el.textContent || host?.textContent || (el as HTMLInputElement).placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return { tag: active.localName, chain, insidePolaris, path, name, indicator: outline || shadow };
  });
}

/** Presses Tab until the focused element is (inside) the element carrying `testId`; fails with the visited stops otherwise. */
export async function tabTo(page: Page, testId: string, max = 80): Promise<FocusInfo> {
  const visited: string[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const info = await focusInfo(page);
    if (info?.chain.includes(testId)) return info;
    visited.push(info ? `${info.tag}:${info.name || info.chain[0] || ''}` : '(body)');
  }
  throw new Error(`Keyboard focus never reached "${testId}" in ${max} Tab presses. Visited: ${visited.join(' > ')}`);
}

/** Same as tabTo but matches an accessible name (button or link) instead of a test id. */
export async function tabToName(page: Page, name: RegExp | string, max = 80): Promise<FocusInfo> {
  const visited: string[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const info = await focusInfo(page);
    if (info && (typeof name === 'string' ? info.name === name : name.test(info.name))) return info;
    visited.push(info ? `${info.tag}:${info.name}` : '(body)');
  }
  throw new Error(`Keyboard focus never reached "${String(name)}" in ${max} Tab presses. Visited: ${visited.join(' > ')}`);
}

/** Visible text of the page, flattened through shadow roots, one string. */
export async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [];
    const walk = (root: Node) => {
      for (const child of Array.from(root.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = (child.textContent ?? '').trim();
          if (t) parts.push(t);
        } else if (child instanceof HTMLElement) {
          if (['SCRIPT', 'STYLE', 'S-OPTION'].includes(child.tagName)) continue;
          const cs = getComputedStyle(child);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          for (const attr of ['label', 'heading', 'details', 'placeholder', 'error']) {
            if (child.localName.startsWith('s-') && child.getAttribute(attr)) parts.push(child.getAttribute(attr)!);
          }
          if (child.shadowRoot) walk(child.shadowRoot);
          walk(child);
        }
      }
    };
    walk(document.body);
    return parts.join('\n');
  });
}

/** Presses the (inner) button of a Polaris button host. */
export async function press(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).getByRole('button').click();
}
