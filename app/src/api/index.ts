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
    const mock = new MockClient({ delayMs: 120 });
    return { client: mock, pickVariants: async () => mock.pickableVariants() };
  }
  return { client: new HttpClient(), pickVariants: bridgePickVariants };
}
