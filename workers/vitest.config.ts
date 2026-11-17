import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd (Miniflare) with the real wrangler config (spec 18.1).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: '../wrangler.jsonc' },
      miniflare: { bindings: { SHOPIFY_API_SECRET: 'test-secret' } },
    }),
  ],
});
