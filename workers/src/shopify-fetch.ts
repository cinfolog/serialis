/**
 * Outbound fetch used for every Shopify call of the shop objects (GraphQL and OAuth). Production
 * uses the global fetch; tests inject the Shopify simulator (`@serialis/shopify-sim`) here.
 */
type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

let override: FetchFn | null = null;

export function shopifyFetch(): FetchFn {
  return override ?? ((input, init) => fetch(input, init));
}

/** Test hook: routes the Shopify calls of every object of this isolate; returns a restore function. */
export function setShopifyFetch(fn: FetchFn | null): () => void {
  const previous = override;
  override = fn;
  return () => {
    override = previous;
  };
}
