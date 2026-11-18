import type { MockClient } from './mock';
import type { PickedVariant } from '../shopify';
import { pickVariants as bridgePickVariants } from '../shopify';
import { HttpClient, type ApiClient } from './client';

/** Everything the screens need from the outside world; swapped as a whole in mock mode and tests. */
export interface Services {
  client: ApiClient;
  /** Shopify variant picker (App Bridge resource picker in production). */
  pickVariants: () => Promise<PickedVariant[]>;
}

export async function createServices(): Promise<Services> {
  if (import.meta.env.VITE_API_MOCK === '1') {
    // Dynamic import: the mock and its fixtures are not part of the production bundle.
    const { MockClient } = await import('./mock');
    // Scenario switches read once at load (`?mock_locale=en&mock_empty=1&mock_role=operator&mock_stop=1&mock_delay=0`),
    // used by the browser tests (tests/ui) and handy in `pnpm dev`.
    const params = new URLSearchParams(window.location.search);
    const delay = Number(params.get('mock_delay') ?? 120);
    const mock = new MockClient({
      delayMs: Number.isFinite(delay) ? delay : 120,
      ...(params.get('mock_locale') === 'en' ? { locale: 'en' as const } : {}),
      ...(params.get('mock_role') === 'operator' ? { role: 'operator' as const } : {}),
      ...(params.get('mock_empty') === '1' ? { empty: true } : {}),
      ...(params.get('mock_shown') === '1' ? { extensionsShown: true } : {}),
    });
    if (params.get('mock_stop') === '1') mock.emergencyStop = true;
    // Handle for the browser tests (fault injection, idempotency log); absent from the production bundle.
    (window as unknown as { __serialisMock?: MockClient }).__serialisMock = mock;
    return { client: mock, pickVariants: async () => mock.pickableVariants() };
  }
  return { client: new HttpClient(), pickVariants: bridgePickVariants };
}
