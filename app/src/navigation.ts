/**
 * The embedded app is loaded by Shopify with `host`, `shop` and `embedded` query parameters that
 * App Bridge needs again if the iframe is reloaded; they are captured once at startup and added
 * to every in-app navigation.
 */
const KEPT = ['host', 'shop', 'embedded', 'locale'] as const;

const initial: Record<string, string> =
  typeof window === 'undefined' ? {} : Object.fromEntries(KEPT.flatMap((k) => { const v = new URLSearchParams(window.location.search).get(k); return v ? [[k, v]] : []; }));

export function withEmbeddedParams(to: string): string {
  if (Object.keys(initial).length === 0) return to;
  const [path = '', query = ''] = to.split('?');
  const params = new URLSearchParams(query);
  for (const [k, v] of Object.entries(initial)) if (!params.has(k)) params.set(k, v);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
