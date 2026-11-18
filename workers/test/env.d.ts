import type { D1Migration } from 'cloudflare:test';
import type { Env as SerialisEnv } from '../src/env.js';

declare global {
  namespace Cloudflare {
    interface Env extends SerialisEnv {
      /** Registry migrations, read in Node by vitest.config.ts. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Cloudflare.Env {}
}

export {};
