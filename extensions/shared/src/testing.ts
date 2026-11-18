/**
 * Test helpers shared by the extension packages: a routed `fetch` mock, response builders and a translator
 * over an extension's generated locale file. Not imported by production code.
 */
import { readFileSync } from 'node:fs';
import { act, waitFor } from '@testing-library/preact';
import type { Allocation, Location, TrackedItem, Unit } from '@serialis/contract';
import { createTranslator, type Translate } from './i18n';

export interface RecordedCall {
  method: string;
  /** Path with query string, as passed to fetch. */
  url: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

export type Handler = (call: RecordedCall) => Response | unknown | Promise<Response | unknown>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** problem+json answer (RFC 9457) with a stable `code`. */
export function problem(status: number, code: string, detail?: string, errors?: unknown[]): Response {
  return json(
    { type: `https://serialis.dev/problems/${code}`, title: code, status, code, ...(detail ? { detail } : {}), ...(errors ? { errors } : {}) },
    status,
    { 'Content-Type': 'application/problem+json' },
  );
}

/**
 * `routes` maps "METHOD /path" (query ignored) to a handler returning a Response or a plain value (sent as 200 JSON).
 * An unrouted call fails the test with a clear message.
 */
export function mockFetch(routes: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const fetchMock = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const parsed = new URL(url, 'https://app.example');
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    const call: RecordedCall = {
      method: (init.method ?? 'GET').toUpperCase(),
      url,
      pathname: parsed.pathname,
      query: parsed.searchParams,
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const handler = routes[`${call.method} ${call.pathname}`];
    if (!handler) throw new Error(`mockFetch: no route for ${call.method} ${call.pathname}`);
    const out = await handler(call);
    if (out instanceof Response) return out;
    if (out === undefined) return new Response(null, { status: 204 });
    return json(out);
  };
  return {
    fetch: fetchMock as typeof fetch,
    calls,
    callsTo: (route: string) => calls.filter((c) => `${c.method} ${c.pathname}` === route),
  };
}

/** Translator over a generated extension locale file (`locales/fr.default.json` or `locales/en.json`). */
export function translatorFromFile(path: string, locale: 'fr' | 'en'): Translate {
  return createTranslator(JSON.parse(readFileSync(path, 'utf8')), locale);
}

// ---------------------------------------------------------------------------
// DOM helpers for Polaris web components, which are unknown elements under jsdom
// ---------------------------------------------------------------------------

/** Sets a property on a custom element (as its real implementation would) and fires the event. */
export function emit(el: Element, event: 'input' | 'change', props: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(props)) Object.defineProperty(el, k, { value: v, configurable: true, writable: true });
  // act() flushes the Preact re-render before the test reads the DOM again.
  void act(() => {
    el.dispatchEvent(new Event(event, { bubbles: true }));
  });
}

/** Types into a text field / text area / select / search field. */
export function typeInto(el: Element, value: string): void {
  emit(el, el.tagName.toLowerCase() === 's-select' ? 'change' : 'input', { value });
}

/** Selects the value of an `<s-choice-list>`. */
export function choose(el: Element, value: string): void {
  emit(el, 'change', { values: [value] });
}

// ---------------------------------------------------------------------------
// Fixtures (contract types; no real shop or customer data)
// ---------------------------------------------------------------------------


export const VARIANT = 'gid://shopify/ProductVariant/1001';
export const PRODUCT = 'gid://shopify/Product/501';
export const ORDER = 'gid://shopify/Order/9001';
export const LINE = 'gid://shopify/LineItem/7001';

export const LOCATIONS: Location[] = [
  { id: 'loc-a', name: 'Entrepôt', active: true },
  { id: 'loc-b', name: 'Boutique', active: true },
];

export function makeUnit(ref: string, over: Partial<Unit> = {}): Unit {
  return {
    id: `unit-${ref}`, variantGid: VARIANT, locationId: 'loc-a', state: 'AVAILABLE',
    identifiers: [{ id: `i-${ref}`, type: 'serial', value: ref, primary: true }], ref,
    receivedAt: '2026-03-01T10:00:00Z', orderGid: null, version: 1,
    createdAt: '2026-03-01T10:00:00Z', updatedAt: '2026-03-01T10:00:00Z', ...over,
  };
}

export function makeTrackedItem(over: Partial<TrackedItem> = {}): TrackedItem {
  return {
    variantGid: VARIANT, productGid: PRODUCT, title: 'Vélo test', variantTitle: 'M', sku: 'SKU-1', mode: 'interchangeable',
    initializing: false, activatedAt: '2026-02-01T00:00:00Z',
    stock: [{ locationId: 'loc-a', shopifyOnHand: 5, registeredUnits: 5, availableUnits: 3 }], ...over,
  };
}

export function makeAllocation(ref: string, over: Partial<Allocation> = {}): Allocation {
  return {
    id: `alloc-${ref}`, unitId: `unit-${ref}`, ref, orderGid: ORDER, lineItemGid: LINE, variantGid: VARIANT, locationId: 'loc-a',
    status: 'active', source: 'auto', toConfirm: false, allocatedAt: '2026-03-02T09:00:00Z', ...over,
  };
}

/**
 * Text a person would read: text nodes plus the `heading`, `label` and `details` attributes of Polaris
 * components (rendered inside their shadow DOM in the real admin, so absent from the light DOM here).
 */
export function pageText(root: ParentNode = document.body): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? '');
    else if (node instanceof Element) {
      for (const a of ['heading', 'label', 'details']) {
        const v = node.getAttribute(a);
        if (v) parts.push(v);
      }
      node.childNodes.forEach(walk);
    }
  };
  root.childNodes.forEach(walk);
  return parts.join(' ').replace(/\s+/g, ' ');
}

/** Waits until the page shows the text (string: substring; RegExp: match). */
export async function see(expected: string | RegExp): Promise<void> {
  await waitFor(() => {
    const text = pageText();
    if (typeof expected === 'string' ? !text.includes(expected) : !expected.test(text)) {
      throw new Error(`Text not found: ${String(expected)}\n--- page text ---\n${text}`);
    }
  });
}

/** The visible value of a field element (text field, text area...). */
export function valueOf(el: Element | null): string {
  return (el as unknown as { value?: string } | null)?.value ?? '';
}
