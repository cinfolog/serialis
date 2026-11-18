import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd (Miniflare) with the real wrangler config (spec 18.1).
// Test-only values: the encryption key is a fixed, public 32-byte test key (bytes 0..31).
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: '../wrangler.jsonc' },
      miniflare: {
        bindings: {
          SHOPIFY_API_SECRET: 'test-secret',
          TOKEN_ENCRYPTION_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, '../db/registry')),
        },
      },
    })),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
