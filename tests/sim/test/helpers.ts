import { createShopifySim } from '../src/index.js';
import type { ShopifySim, SimOptions } from '../src/index.js';

export const ENDPOINT = 'https://sim-shop.myshopify.com/admin/api/2026-10/graphql.json';

export async function gql(sim: ShopifySim, query: string, variables: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<any> {
  const res = await sim.fetch(new Request(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ query, variables }) }));
  return res.json();
}

export interface Fixture {
  sim: ShopifySim;
  loc: string;
  loc2: string;
  variantId: string;
  itemId: string;
  variant2Id: string;
}

export function fixture(opts: SimOptions = {}): Fixture {
  const sim = createShopifySim(opts);
  const loc = sim.addLocation('Main');
  const loc2 = sim.addLocation('Second');
  const p = sim.addProduct('Bike', [{ title: 'M', sku: 'BIKE-M', stock: { [loc]: 10 } }, { title: 'L', sku: 'BIKE-L', stock: { [loc]: 5 } }]);
  return { sim, loc, loc2, variantId: p.variantIds[0] as string, itemId: p.itemIds[0] as string, variant2Id: p.variantIds[1] as string };
}

export function level(sim: ShopifySim, itemId: string, loc: string): Record<string, number> {
  const lv = sim.shop.getLevel(itemId, loc);
  if (!lv) throw new Error('no level');
  return { ...lv.q, on_hand: sim.shop.quantity(lv, 'on_hand') };
}

export const ADJUST = `mutation Adj($input: InventoryAdjustQuantitiesInput!, $key: String!) @idempotent(key: $key) {
  inventoryAdjustQuantities(input: $input) {
    inventoryAdjustmentGroup { id changes { name delta quantityAfterChange ledgerDocumentUri } }
    userErrors { field message code }
  }
}`;
