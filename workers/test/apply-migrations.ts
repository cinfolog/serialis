import { applyD1Migrations, env } from 'cloudflare:test';

// Registry migrations (db/registry) applied to the test D1 before each test file; idempotent.
await applyD1Migrations(env.REGISTRY, env.TEST_MIGRATIONS);
