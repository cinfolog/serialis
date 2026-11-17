// Creates the Cloudflare resources of one environment if missing (idempotent) and prints their ids
// as GitHub annotations, readable from the check run (spec 10.4). Ids are not secrets.
// Usage: node scripts/bootstrap-cloudflare.mjs <staging|pilot|production> (rerun: 2026-11-17, KV and R2 permissions)
import { execFileSync } from 'node:child_process';

const env = process.argv[2];
if (!['staging', 'pilot', 'production'].includes(env)) {
  console.error('usage: bootstrap-cloudflare.mjs <staging|pilot|production>');
  process.exit(2);
}
const euData = env !== 'staging'; // pilot and production keep data in the EU (spec 10.5)

const wrangler = (...args) => {
  try {
    return execFileSync('pnpm', ['exec', 'wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // Surface wrangler's message as an annotation (the only output readable outside the job log).
    const out = `${e.stderr ?? ''}${e.stdout ?? ''}`.replace(/\s+/g, ' ').slice(0, 600);
    e.wranglerOutput = out;
    console.log(`::error title=wrangler ${args.slice(0, 3).join(' ')}::${out}`);
    throw e;
  }
};

const notice = (msg) => console.log(`::notice title=bootstrap ${env}::${msg}`);

// D1 registry
const d1Name = `serialis-registry-${env}`;
const findD1 = () => JSON.parse(wrangler('d1', 'list', '--json')).find((d) => d.name === d1Name);
let d1 = findD1();
if (!d1) {
  wrangler('d1', 'create', d1Name, ...(euData ? ['--jurisdiction', 'eu'] : []));
  d1 = findD1();
}
notice(`D1 ${d1Name} = ${d1.uuid}`);

// KV shop routing
const kvTitle = `serialis-shop-routing-${env}`;
const findKv = () => JSON.parse(wrangler('kv', 'namespace', 'list')).find((n) => n.title === kvTitle);
let kv = findKv();
if (!kv) {
  wrangler('kv', 'namespace', 'create', kvTitle);
  kv = findKv();
}
notice(`KV ${kvTitle} = ${kv.id}`);

// R2 files
const bucket = `serialis-files-${env}`;
try {
  wrangler('r2', 'bucket', 'create', bucket, ...(euData ? ['--jurisdiction', 'eu'] : []));
  notice(`R2 ${bucket} created`);
} catch (e) {
  if (!/already exists|10004/i.test(e.wranglerOutput ?? '')) throw e;
  notice(`R2 ${bucket} already exists`);
}
