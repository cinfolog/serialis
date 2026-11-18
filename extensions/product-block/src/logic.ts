import type { Gid, Location, TrackedItem } from '@serialis/contract';
import type { ApiClient } from '@serialis/extensions-shared';

/** A variant as read from the Shopify Admin API by the extension (`shopify.query`). */
export interface ShopifyVariant {
  id: Gid;
  title: string;
  sku: string | null;
}

export type VariantLoader = (productGid: Gid, signal?: AbortSignal) => Promise<ShopifyVariant[]>;

export interface ProductData {
  locations: Location[];
  items: TrackedItem[];
  /** Null when the Shopify variants could not be read: the block then lists the tracked items only. */
  variants: ShopifyVariant[] | null;
}

async function listAllTrackedItems(api: ApiClient, productGid: Gid, signal?: AbortSignal): Promise<TrackedItem[]> {
  const items: TrackedItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const q = { product: productGid, limit: 250, ...(cursor ? { cursor } : {}) };
    const res = await api.listTrackedItems(q, signal ? { signal } : {});
    items.push(...res.items);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return items;
}

export async function loadProductData(
  api: ApiClient,
  loadVariants: VariantLoader,
  productGid: Gid,
  signal?: AbortSignal,
): Promise<ProductData> {
  const [locations, items, variants] = await Promise.all([
    api.listLocations(signal ? { signal } : {}),
    listAllTrackedItems(api, productGid, signal),
    loadVariants(productGid, signal).catch((): null => null),
  ]);
  return { locations: locations.items, items, variants };
}

export interface VariantRow {
  variantGid: Gid;
  title: string;
  sku: string | null;
  tracked: boolean;
  initializing: boolean;
  /** Available units per location that has stock or units (locations with zero are omitted). */
  available: Array<{ locationId: string; name: string; count: number }>;
  totalAvailable: number;
  /** Sum over locations of (Shopify on_hand - registered units): positive = units still to register. */
  gap: number;
}

/** One row per Shopify variant (tracked or not); tracked items unknown to Shopify's list are appended. */
export function buildRows(data: ProductData, untitled: string): VariantRow[] {
  const names = new Map(data.locations.map((l) => [l.id, l.name]));
  const byVariant = new Map(data.items.map((i) => [i.variantGid, i]));
  const rows: VariantRow[] = [];
  const row = (variantGid: Gid, title: string, sku: string | null): VariantRow => {
    const item = byVariant.get(variantGid);
    const available = (item?.stock ?? [])
      .filter((s) => s.availableUnits > 0)
      .map((s) => ({ locationId: s.locationId, name: names.get(s.locationId) ?? s.locationId, count: s.availableUnits }));
    return {
      variantGid,
      title,
      sku,
      tracked: !!item,
      initializing: item?.initializing ?? false,
      available,
      totalAvailable: available.reduce((n, a) => n + a.count, 0),
      gap: (item?.stock ?? []).reduce((n, s) => n + (s.shopifyOnHand - s.registeredUnits), 0),
    };
  };
  const seen = new Set<Gid>();
  for (const v of data.variants ?? []) {
    seen.add(v.id);
    rows.push(row(v.id, v.title, v.sku));
  }
  for (const item of data.items) {
    if (seen.has(item.variantGid)) continue;
    rows.push(row(item.variantGid, item.variantTitle ?? untitled, item.sku));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Shopify Admin GraphQL (read-only, scope read_products)
// ---------------------------------------------------------------------------

export const VARIANTS_QUERY = /* GraphQL */ `
  query SerialisProductVariants($id: ID!, $after: String) {
    product(id: $id) {
      variants(first: 250, after: $after) {
        nodes { id title sku }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

interface VariantsResponse {
  product: {
    variants: {
      nodes: Array<{ id: string; title: string; sku: string | null }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
}

export type ShopifyQuery = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<{ data?: unknown; errors?: unknown[] }>;

/** Reads the variants of a product through `shopify.query`, following pagination (at most 8 pages). */
export function createVariantLoader(query: ShopifyQuery): VariantLoader {
  return async (productGid) => {
    const out: ShopifyVariant[] = [];
    let after: string | null = null;
    for (let page = 0; page < 8; page++) {
      const res = await query(VARIANTS_QUERY, { variables: { id: productGid, after } });
      if (res.errors?.length) throw new Error('GraphQL error');
      const conn = (res.data as VariantsResponse | undefined)?.product?.variants;
      if (!conn) break;
      out.push(...conn.nodes.map((n) => ({ id: n.id, title: n.title, sku: n.sku })));
      if (!conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    return out;
  };
}
