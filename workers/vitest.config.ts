import fs from 'node:fs';
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The wrangler config serves app/dist (admin app); tests only need the directory to exist.
const appDist = path.join(import.meta.dirname, '../app/dist');
if (!fs.existsSync(path.join(appDist, 'index.html'))) {
  fs.mkdirSync(appDist, { recursive: true });
  fs.writeFileSync(path.join(appDist, 'index.html'), '<!doctype html><meta name="shopify-api-key" content="%SHOPIFY_API_KEY%"><title>Serialis</title>');
}

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
