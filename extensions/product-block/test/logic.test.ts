import { describe, expect, it, vi } from 'vitest';
import { LOCATIONS, makeTrackedItem } from '@serialis/extensions-shared/testing';
import { VARIANTS_QUERY, buildRows, createVariantLoader, type ProductData } from '../src/logic';

const V1 = 'gid://shopify/ProductVariant/1';
const V2 = 'gid://shopify/ProductVariant/2';
const V3 = 'gid://shopify/ProductVariant/3';

describe('buildRows', () => {
  const data: ProductData = {
    locations: LOCATIONS,
    variants: [
      { id: V1, title: 'S', sku: 'SKU-S' },
      { id: V2, title: 'M', sku: null },
    ],
    items: [
      makeTrackedItem({
        variantGid: V1,
        stock: [
          { locationId: 'loc-a', shopifyOnHand: 5, registeredUnits: 3, availableUnits: 2 },
          { locationId: 'loc-b', shopifyOnHand: 1, registeredUnits: 1, availableUnits: 1 },
          { locationId: 'loc-c', shopifyOnHand: 0, registeredUnits: 0, availableUnits: 0 },
        ],
      }),
      makeTrackedItem({ variantGid: V3, variantTitle: null, sku: 'SKU-X', initializing: true, stock: [] }),
    ],
  };

  it('has one row per Shopify variant, tracked or not, then the tracked items unknown to the list', () => {
    const rows = buildRows(data, 'Sans titre');
    expect(rows.map((r) => [r.variantGid, r.title, r.tracked])).toEqual([
      [V1, 'S', true], [V2, 'M', false], [V3, 'Sans titre', true],
    ]);
  });

  it('lists available units per location (zero omitted) and the total gap', () => {
    const [v1, v2, v3] = buildRows(data, '?');
    expect(v1!.available).toEqual([
      { locationId: 'loc-a', name: 'Entrepôt', count: 2 },
      { locationId: 'loc-b', name: 'Boutique', count: 1 },
    ]);
    expect(v1!.totalAvailable).toBe(3);
    expect(v1!.gap).toBe(2);
    expect(v2).toMatchObject({ tracked: false, available: [], gap: 0 });
    expect(v3).toMatchObject({ initializing: true, sku: 'SKU-X' });
  });

  it('falls back to the tracked items when Shopify variants are unavailable', () => {
    const rows = buildRows({ ...data, variants: null }, '?');
    expect(rows.map((r) => r.variantGid)).toEqual([V1, V3]);
  });
});

describe('createVariantLoader', () => {
  it('follows GraphQL pagination and maps nodes', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ data: { product: { variants: { nodes: [{ id: V1, title: 'S', sku: 'A' }], pageInfo: { hasNextPage: true, endCursor: 'c1' } } } } })
      .mockResolvedValueOnce({ data: { product: { variants: { nodes: [{ id: V2, title: 'M', sku: null }], pageInfo: { hasNextPage: false, endCursor: null } } } } });
    const out = await createVariantLoader(query)('gid://shopify/Product/501');
    expect(out).toEqual([{ id: V1, title: 'S', sku: 'A' }, { id: V2, title: 'M', sku: null }]);
    expect(query).toHaveBeenNthCalledWith(1, VARIANTS_QUERY, { variables: { id: 'gid://shopify/Product/501', after: null } });
    expect(query).toHaveBeenNthCalledWith(2, VARIANTS_QUERY, { variables: { id: 'gid://shopify/Product/501', after: 'c1' } });
  });

  it('rejects on GraphQL errors and yields nothing for an unknown product', async () => {
    await expect(createVariantLoader(async () => ({ errors: [{}] }))('p')).rejects.toThrow();
    await expect(createVariantLoader(async () => ({ data: { product: null } }))('p')).resolves.toEqual([]);
  });
});
