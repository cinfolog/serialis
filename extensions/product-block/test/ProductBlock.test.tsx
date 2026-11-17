import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createApiClient } from '@serialis/extensions-shared';
import { LOCATIONS, PRODUCT, makeTrackedItem, mockFetch, pageText, problem, see, translatorFromFile } from '@serialis/extensions-shared/testing';
import { ProductBlock } from '../src/ProductBlock';
import type { VariantLoader } from '../src/logic';

const t = translatorFromFile(join(import.meta.dirname, '..', 'locales', 'fr.default.json'), 'fr');
const tEn = translatorFromFile(join(import.meta.dirname, '..', 'locales', 'en.json'), 'en');
afterEach(cleanup);

const V1 = 'gid://shopify/ProductVariant/1';
const V2 = 'gid://shopify/ProductVariant/2';
const page = <T,>(items: T[]) => ({ items, nextCursor: null });
const variants: VariantLoader = async () => [
  { id: V1, title: 'Taille S', sku: 'SKU-S' },
  { id: V2, title: 'Taille M', sku: 'SKU-M' },
];

function setup(extra: Parameters<typeof mockFetch>[0] = {}, loader: VariantLoader = variants, translate = t) {
  const m = mockFetch({
    'GET /api/v1/locations': () => page(LOCATIONS),
    'GET /api/v1/tracked-items': () =>
      page([makeTrackedItem({ variantGid: V1, stock: [{ locationId: 'loc-a', shopifyOnHand: 4, registeredUnits: 3, availableUnits: 2 }, { locationId: 'loc-b', shopifyOnHand: 2, registeredUnits: 2, availableUnits: 2 }] })]),
    ...extra,
  });
  render(<ProductBlock api={createApiClient({ fetch: m.fetch })} t={translate} productGid={PRODUCT} loadVariants={loader} />);
  return m;
}

describe('ProductBlock', () => {
  it('summarizes each variant: tracked or not, available units per location, link to the variant', async () => {
    const m = setup();
    await see('Taille S');
    const text = pageText();
    expect(text).toContain('1 variante suivie sur 2');
    expect(text).toContain('Suivie');
    expect(text).toContain('Non suivie');
    expect(text).toContain('Entrepôt : 2');
    expect(text).toContain('Boutique : 2');
    expect(text).toContain('+1'); // one unit still to register
    const links = [...document.querySelectorAll('s-link')].map((l) => l.getAttribute('href'));
    expect(links).toEqual(['shopify:admin/products/501/variants/1', 'shopify:admin/products/501/variants/2']);
    expect(m.callsTo('GET /api/v1/tracked-items')[0]!.query.get('product')).toBe(PRODUCT);
  });

  it('is available in English', async () => {
    setup({}, variants, tEn);
    await see('1 of 2 variants tracked');
    expect(pageText()).toContain('Not tracked');
  });

  it('lists only the tracked variants when Shopify variants cannot be read', async () => {
    setup({}, async () => {
      throw new Error('no access');
    });
    await see('seules les variantes suivies sont affichées');
    expect(document.querySelectorAll('s-table-row')).toHaveLength(1);
  });

  it('shows an error with retry when the app backend fails', async () => {
    setup({ 'GET /api/v1/tracked-items': () => problem(500, 'unknown') });
    await see('Action impossible');
    expect(pageText()).toContain('Réessayer');
  });

  it('says so when the product has no variant', async () => {
    setup({ 'GET /api/v1/tracked-items': () => page([]) }, async () => []);
    await see('Ce produit n\'a aucune variante');
  });

  it('shows the offline banner', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    setup();
    await see('Hors connexion');
  });
});
