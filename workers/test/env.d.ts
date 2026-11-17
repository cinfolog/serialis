import type { Env as SerialisEnv } from '../src/env.js';

declare global {
  namespace Cloudflare {
    interface Env extends SerialisEnv {}
  }
}

declare module 'cloudflare:test' {
  interface ProvidedEnv extends SerialisEnv {}
}

export {};
