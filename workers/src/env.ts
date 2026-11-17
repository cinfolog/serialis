import type { ShopStore } from './shop-store.js';

export interface Env {
  SHOP_STORE: DurableObjectNamespace<ShopStore>;
  REGISTRY: D1Database;
  SHOP_ROUTING: KVNamespace;
  FILES: R2Bucket;
  ENVIRONMENT: 'development' | 'staging' | 'pilot' | 'production';
  /** Public client id of the Shopify app of this environment (shopify.app.<env>.toml). */
  SHOPIFY_API_KEY: string;
  /** Secret: `wrangler secret put SHOPIFY_API_SECRET --env <env>` (never in the repo). */
  SHOPIFY_API_SECRET: string;
}
