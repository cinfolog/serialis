import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * In mock mode (`pnpm dev`) the page is not embedded in the Shopify admin: App Bridge would try to
 * redirect to the admin, so its script and the api-key meta are removed. Polaris stays for the look.
 */
function mockWithoutAppBridge(enabled: boolean): Plugin {
  return {
    name: 'serialis-mock-without-app-bridge',
    transformIndexHtml(html) {
      if (!enabled) return html;
      return html.replace(/<!--app-bridge-->[\s\S]*?<!--\/app-bridge-->/, '');
    },
  };
}

export default defineConfig(({ mode }) => {
  const mock = mode === 'mock' || process.env['VITE_API_MOCK'] === '1';
  return {
    plugins: [react(), mockWithoutAppBridge(mock)],
    define: { 'import.meta.env.VITE_API_MOCK': JSON.stringify(mock ? '1' : '') },
    build: { outDir: 'dist', sourcemap: true },
    server: { port: 5173 },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      testTimeout: 15_000,
    },
  };
});
