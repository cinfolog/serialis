import { describe, expect, it } from 'vitest';
import { hmacSha256Base64 } from '../src/index.js';
import type { Delivery } from '../src/index.js';
import { fixture } from './helpers.js';

const URL = 'https://hooks.example.test/webhooks/shopify';

function recorder() {
  const seen: Request[] = [];
  return { seen, send: async (r: Request) => { seen.push(r.clone()); return new Response('ok'); } };
}

describe('webhook delivery', () => {
  it('signs with HMAC-SHA256 base64 and sets Shopify headers', async () => {
    const f = fixture({ webhookSecret: 'topsecret' });
    f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 1 }] });
    const rec = recorder();
    const report = await f.sim.webhooks.deliver({ url: URL, send: rec.send });
    expect(report.deliveries.map((d) => d.status)).toEqual([200, 200, 200, 200]);
    const req = rec.seen.find((r) => r.headers.get('x-shopify-topic') === 'orders/create')!;
    const body = await req.text();
    expect(req.headers.get('x-shopify-hmac-sha256')).toBe(await hmacSha256Base64('topsecret', body));
    expect(req.headers.get('x-shopify-shop-domain')).toBe('sim-shop.myshopify.com');
    expect(req.headers.get('x-shopify-api-version')).toBe('2026-10');
    expect(req.headers.get('x-shopify-webhook-id')).toMatch(/^sim-wh-/);
    expect(Date.parse(req.headers.get('x-shopify-triggered-at')!)).not.toBeNaN();
    expect(JSON.parse(body).name).toBe('#1001');
    expect(f.sim.webhooks.pending()).toHaveLength(0);
  });

  it('duplicates keep the same webhook id', async () => {
    const f = fixture();
    f.sim.merchant.adjustInventory({ itemId: f.itemId, locationId: f.loc, delta: 1 });
    const rec = recorder();
    await f.sim.webhooks.deliver({ url: URL, send: rec.send, duplicate: 2 });
    expect(rec.seen).toHaveLength(3);
    expect(new Set(rec.seen.map((r) => r.headers.get('x-shopify-webhook-id'))).size).toBe(1);
  });

  it('reverse and seeded shuffle reorder; same seed gives the same order', async () => {
    const f = fixture();
    const o = f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 2 }] });
    o.fulfill();
    const ids = () => f.sim.shop.events.map((e) => e.id);
    const run = async (reorder: 'reverse' | 'shuffle') => {
      const rec = recorder();
      await f.sim.webhooks.deliver({ url: URL, send: rec.send, events: [...f.sim.shop.events], reorder, seed: 7 });
      return rec.seen.map((r) => r.headers.get('x-shopify-webhook-id'));
    };
    expect(await run('reverse')).toEqual([...ids()].reverse());
    const s1 = await run('shuffle');
    expect(s1).toEqual(await run('shuffle'));
    expect(s1).not.toEqual(ids());
    expect([...s1].sort()).toEqual([...ids()].sort());
  });

  it('a delayed webhook arrives after later ones and advances the sim clock', async () => {
    const f = fixture();
    f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 1 }] });
    const first = f.sim.shop.events[0]!;
    const rec = recorder();
    const t0 = f.sim.clock.now();
    const report = await f.sim.webhooks.deliver({ url: URL, send: rec.send, delayMs: (e) => (e === first ? 30_000 : 0) });
    expect(rec.seen.at(-1)?.headers.get('x-shopify-webhook-id')).toBe(first.id);
    expect(f.sim.clock.now()).toBeGreaterThanOrEqual(t0 + 29_000);
    expect(report.deliveries.at(-1)?.event).toBe(first);
  });

  it('drops a seeded share of events (T-CH-01) and reports them', async () => {
    const f = fixture();
    for (let i = 0; i < 50; i++) f.sim.merchant.adjustInventory({ itemId: f.itemId, locationId: f.loc, delta: 1 });
    const rec = recorder();
    const report = await f.sim.webhooks.deliver({ url: URL, send: rec.send, drop: 0.2, seed: 3 });
    expect(report.dropped.length).toBeGreaterThan(3);
    expect(report.dropped.length).toBeLessThan(20);
    expect(rec.seen.length + report.dropped.length).toBe(50);
  });

  it('collects send errors and supports concurrent delivery and bad secrets', async () => {
    const f = fixture();
    f.sim.merchant.adjustInventory({ itemId: f.itemId, locationId: f.loc, delta: 1 });
    f.sim.merchant.adjustInventory({ itemId: f.itemId, locationId: f.loc, delta: 1 });
    const report = await f.sim.webhooks.deliver({ url: URL, send: async () => { throw new Error('boom'); }, concurrent: true });
    expect(report.deliveries.every((d: Delivery) => d.error instanceof Error)).toBe(true);
    const rec = recorder();
    await f.sim.webhooks.deliver({ url: URL, send: rec.send, events: [f.sim.shop.events[0]!], secret: 'wrong' });
    const body = await rec.seen[0]!.text();
    expect(rec.seen[0]!.headers.get('x-shopify-hmac-sha256')).not.toBe(await hmacSha256Base64(f.sim.webhookSecret, body));
  });

  it('requests() builds signed requests without consuming events', async () => {
    const f = fixture();
    f.sim.merchant.adjustInventory({ itemId: f.itemId, locationId: f.loc, delta: 1 });
    const reqs = await f.sim.webhooks.requests(URL);
    expect(reqs).toHaveLength(1);
    expect(f.sim.webhooks.pending()).toHaveLength(1);
  });
});
