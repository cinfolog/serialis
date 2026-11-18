import type { ShopStore } from './shop-store.js';

export interface Env {
  SHOP_STORE: DurableObjectNamespace<ShopStore>;
  REGISTRY: D1Database;
  SHOP_ROUTING: KVNamespace;
  FILES: R2Bucket;
  /** Static files of the embedded admin app (`app/dist`, wrangler `assets`, run_worker_first). */
  ASSETS: Fetcher;
  ENVIRONMENT: 'development' | 'staging' | 'pilot' | 'production';
  /** Public client id of the Shopify app of this environment (shopify.app.<env>.toml). */
  SHOPIFY_API_KEY: string;
  /** Secret: `wrangler secret put SHOPIFY_API_SECRET --env <env>` (never in the repo). */
  SHOPIFY_API_SECRET: string;
  /**
   * Secret: AES-256-GCM key(s) for the Shopify tokens at rest (spec 16). Either one base64 key
   * (version 1) or a comma-separated keyring `2:<base64>,1:<base64>`; the first key encrypts,
   * all of them decrypt (rotation without downtime).
   */
  TOKEN_ENCRYPTION_KEY: string;
}
