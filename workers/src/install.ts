/**
 * Installation from the embedded app (spec 9.14 F14, 10.5):
 * 1. the session token is verified (caller);
 * 2. first installation only: online token exchange, then `shop { id billingAddress { countryCodeV2 } }`
 *    to choose the placement (EU jurisdiction or location hint); the online token is then dropped;
 * 3. registry (D1) and KV are written;
 * 4. the shop's object is installed: it creates its schema and runs the offline token exchange itself,
 *    serialised with any other exchange or refresh.
 * A reinstallation keeps the existing object (placement fixed at creation) and reactivates it.
 */
import { AdminGraphqlClient, exchangeForOnlineToken, type SessionToken } from '@serialis/shopify';
import type { Env } from './env.js';
import { placementFor, registerInstall, resolveRouting, shopStub, type ShopRouting } from './routing.js';
import type { InstallResult } from './shop-store.js';

export interface InstallOutcome {
  routing: ShopRouting;
  install: InstallResult;
}

const SHOP_QUERY = `query SerialisShopPlacement { shop { id billingAddress { countryCodeV2 } } }`;

export async function installFromSessionToken(env: Env, session: SessionToken): Promise<InstallOutcome> {
  let routing = await resolveRouting(env, session.shop);
  if (routing?.status === 'inactive') {
    // Reinstallation before redaction: same object, same placement.
    routing = await registerInstall(env, session.shop, { placement: routing, shopifyShopGid: null });
  } else if (!routing) {
    const online = await exchangeForOnlineToken(session.raw, { shop: session.shop, apiKey: env.SHOPIFY_API_KEY, apiSecret: env.SHOPIFY_API_SECRET });
    const client = new AdminGraphqlClient({ shop: session.shop, accessToken: online.accessToken, maxRetries: 2 });
    const { data } = await client.request<{ shop: { id: string; billingAddress: { countryCodeV2: string | null } | null } }>(SHOP_QUERY, { estimatedCost: 2 });
    routing = await registerInstall(env, session.shop, {
      placement: placementFor(data.shop.billingAddress?.countryCodeV2),
      shopifyShopGid: data.shop.id,
    });
  }
  // Active or frozen: nothing to change in the registry; the object call below is idempotent.
  const install = await shopStub(env, routing).install({ shopDomain: session.shop, objectName: routing.objectName, sessionToken: session.raw });
  return { routing, install };
}
