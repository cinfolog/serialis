import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../App';
import type { Services } from '../api';
import { MockClient, MOCK_CANDIDATES, type MockOptions } from '../api/mock';

export interface Rendered {
  mock: MockClient;
  services: Services;
}

/** Renders the whole app (router, session, shell) on `route` with an in-memory mock client. */
export function renderApp(route = '/', options: MockOptions & { mock?: MockClient } = {}): Rendered {
  const mock = options.mock ?? new MockClient(options);
  const services: Services = { client: mock, pickVariants: async () => mock.pickableVariants() };
  render(
    <MemoryRouter initialEntries={[route]}>
      <App services={services} />
    </MemoryRouter>,
  );
  return { mock, services };
}

export const candidates = MOCK_CANDIDATES;

const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Current Polaris page (`<s-page heading=...>`). */
export async function pageHeading(expected?: string): Promise<string> {
  let heading = '';
  await waitFor(() => {
    const page = document.querySelector('s-page');
    expect(page).not.toBeNull();
    heading = page?.getAttribute('heading') ?? '';
    if (expected !== undefined) expect(heading).toBe(expected);
  });
  return heading;
}

/** `<s-button>` (or `<s-link>`) whose text is exactly `label`; scoped to `root` when given. */
export function button(label: string | RegExp, root: ParentNode = document): HTMLElement {
  const all = [...root.querySelectorAll<HTMLElement>('s-button')];
  const found = all.find((b) => (typeof label === 'string' ? text(b) === label : label.test(text(b))));
  if (!found) throw new Error(`Button "${String(label)}" not found. Buttons: ${all.map(text).join(' | ')}`);
  return found;
}

/** Link of the in-page navigation (shown when App Bridge is absent), e.g. navLink('Anomalies'). */
export function navLink(label: string): HTMLElement {
  const links = [...document.querySelectorAll<HTMLElement>('nav s-link')];
  const found = links.find((l) => text(l) === label);
  if (!found) throw new Error(`Nav link "${label}" not found. Links: ${links.map(text).join(' | ')}`);
  return found;
}

export async function findButton(label: string | RegExp, root: ParentNode = document): Promise<HTMLElement> {
  return waitFor(() => button(label, root));
}

/** Polaris field (text field, text area, select, checkbox) by its `label` attribute. */
export function field(label: string, root: ParentNode = document): HTMLElement {
  const el = [...root.querySelectorAll<HTMLElement>('[label]')].find((e) => e.getAttribute('label') === label);
  if (!el) {
    const labels = [...root.querySelectorAll('[label]')].map((e) => e.getAttribute('label'));
    throw new Error(`Field "${label}" not found. Fields: ${labels.join(' | ')}`);
  }
  return el;
}

export async function findField(label: string, root: ParentNode = document): Promise<HTMLElement> {
  return waitFor(() => field(label, root));
}

export function typeIn(el: HTMLElement, value: string): void {
  (el as unknown as { value: string }).value = value;
  fireEvent.input(el);
}

export function choose(el: HTMLElement, value: string): void {
  (el as unknown as { value: string }).value = value;
  fireEvent.change(el);
}

export function setChecked(el: HTMLElement, checked: boolean): void {
  (el as unknown as { checked: boolean }).checked = checked;
  fireEvent.change(el);
}

export function press(el: HTMLElement): void {
  fireEvent.click(el);
}

export function pressKey(el: HTMLElement, key: string): void {
  fireEvent.keyDown(el, { key });
}

export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

export { act, fireEvent, screen, waitFor, within, text };
