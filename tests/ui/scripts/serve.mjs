// Minimal static server for the admin app built in mock mode (app/dist): same routing contract as the
// Worker (spec: every navigation route answers index.html with no-store, assets are immutable).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../../app/dist', import.meta.url)));
const port = Number(process.env.UI_TESTS_PORT ?? 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json', '.svg': 'image/svg+xml', '.json': 'application/json' };

if (!existsSync(join(root, 'index.html'))) {
  console.error(`app/dist is missing: run "VITE_API_MOCK=1 pnpm --filter @serialis/admin build" first (${root})`);
  process.exit(1);
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const candidate = normalize(join(root, decodeURIComponent(url.pathname)));
  const isAsset = candidate.startsWith(root) && existsSync(candidate) && statSync(candidate).isFile() && !candidate.endsWith('index.html');
  const file = isAsset ? candidate : join(root, 'index.html');
  res.writeHead(200, {
    'Content-Type': types[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': isAsset && url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`serialis admin (mock) on http://127.0.0.1:${port}`));
