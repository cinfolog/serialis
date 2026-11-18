/**
 * End-to-end harness (spec 18.1, 18.3): the Shopify simulator is the outbound fetch of the shop
 * objects, its signed webhooks are delivered to the Worker (`SELF.fetch`), and the shop object's
 * alarm is run explicitly until the work is done.
 */
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { Clock, createShopifySim, type DeliveryOptions, type ShopifySim, type SimOptions } from '@serialis/shopify-sim';
import { expect } from 'vitest';
import { registerInstall, shopStub } from '../src/routing.js';
import type { ShopStore } from '../src/shop-store.js';
import { setShopifyFetch } from '../src/shopify-fetch.js';
import { SECRET, sessionToken } from './helpers.js';

/** Simulator clock following the real time (the Worker reads `Date.now()`), plus the advances asked by the sim. */
class LiveClock extends Clock {
  private offset = 0;
  override now(): number {
    return Date.now() + this.offset;
  }
  override iso(): string {
    return new Date(this.now()).toISOString();
  }
  override advance(ms: number): void {
    this.offset += ms;
  }
  override tick(): void {
    this.offset += 1;
  }
}

let counter = 0;
/** One simulator per shop domain: objects of earlier tests that still run their alarms reach their own shop. */
const sims = new Map<string, ShopifySim>();
let routed = false;
function routeShopifyCalls(): void {
  if (routed) return;
  routed = true;
  setShopifyFetch((input, init) => {
    const sim = sims.get(new URL(input).hostname);
    return sim ? sim.fetch(input, init) : Promise.resolve(new Response('Not Found', { status: 404 }));
  });
}
const WEBHOOK_URL = 'https://hooks.serialis.dev/webhooks/shopify';

export interface Harness {
  shop: string;
  sim: ShopifySim;
  stub: DurableObjectStub<ShopStore>;
  restore(): void;
  deliver(opts?: Partial<DeliveryOptions>): Promise<void>;
  /** Runs tasks and outbox (forcing their dates) and delivers the webhooks they cause, until nothing is left. */
  drain(opts?: { deliver?: Partial<DeliveryOptions>; rounds?: number }): Promise<void>;
  /** One forced alarm run (tasks due within a minute and the outbox), without delivering webhooks. */
  step(): Promise<void>;
  api(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  query<T = Record<string, unknown>>(sql: string, ...binds: SqlStorageValue[]): Promise<T[]>;
  run(sql: string, ...binds: SqlStorageValue[]): Promise<void>;
}

export async function createHarness(name: string, opts: { webhookOrigin?: string; sim?: SimOptions } = {}): Promise<Harness> {
  counter += 1;
  const shop = `${name}-${counter}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
  const sim = createShopifySim({ ...opts.sim, domain: shop, webhookSecret: SECRET, clock: new LiveClock() });
  routeShopifyCalls();
  sims.set(shop, sim);
  const restoreFetch = () => {
    sims.delete(shop);
  };
  const routing = await registerInstall(env, shop, { placement: { jurisdiction: null, locationHint: null }, shopifyShopGid: null });
  const stub = shopStub(env, routing);
  await stub.install({ shopDomain: shop, objectName: routing.objectName, sessionToken: await sessionToken(shop) });

  const h: Harness = {
    shop,
    sim,
    stub,
    restore: restoreFetch,
    async deliver(o = {}) {
      const report = await sim.webhooks.deliver({ url: WEBHOOK_URL, send: (r) => SELF.fetch(r), ...o });
      for (const d of report.deliveries) {
        if (d.error) throw d.error;
        expect(d.status, `webhook ${d.event.topic}`).toBe(200);
      }
    },
    async drain(o = {}) {
      const rounds = o.rounds ?? 200;
      for (let i = 0; i < rounds; i++) {
        await h.deliver(o.deliver ?? {});
        const due = await runInDurableObject(stub, async (_s: ShopStore, state: DurableObjectState) => {
          const sql = state.storage.sql;
          // Tasks due within a minute (webhook coalescing, retries) are forced; longer waits (grace period S-22, passes) are not.
          sql.exec("UPDATE tasks SET run_at = 0 WHERE status = 'pending' AND key NOT LIKE 'recon:%' AND run_at <= ?", Date.now() + 60_000);
          sql.exec("UPDATE outbox SET next_attempt_at = 0 WHERE status = 'pending'");
          sql.exec("UPDATE tasks SET run_at = 0 WHERE status = 'pending' AND kind = 'process_outbox'");
          const n = Number(sql.exec("SELECT count(*) AS n FROM tasks WHERE status = 'pending' AND run_at <= ?", Date.now()).one().n);
          // Work started by the object's own alarm (it may fire by itself between two steps of the test).
          const busy =
            Number(sql.exec("SELECT count(*) AS n FROM tasks WHERE status = 'running'").one().n) +
            Number(sql.exec("SELECT count(*) AS n FROM outbox WHERE status = 'in_flight'").one().n);
          // Armed in the future so that it cannot fire by itself while the test runs it.
          if (busy === 0) await state.storage.setAlarm(Date.now() + 60_000);
          return { n, busy };
        });
        if (due.busy > 0) {
          await new Promise((r) => setTimeout(r, 25));
          continue;
        }
        if (due.n === 0 && sim.webhooks.pending().length === 0) return;
        if (due.n > 0) await runDurableObjectAlarm(stub);
      }
      throw new Error('drain: work still pending after the maximum number of rounds');
    },
    async step() {
      await runInDurableObject(stub, async (_s: ShopStore, state: DurableObjectState) => {
        state.storage.sql.exec("UPDATE tasks SET run_at = 0 WHERE status = 'pending' AND key NOT LIKE 'recon:%' AND run_at <= ?", Date.now() + 60_000);
        state.storage.sql.exec("UPDATE outbox SET next_attempt_at = 0 WHERE status = 'pending'");
        await state.storage.setAlarm(Date.now() + 60_000);
      });
      await runDurableObjectAlarm(stub);
    },
    async api(method, path, body, headers = {}) {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${await sessionToken(shop)}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
          ...(opts.webhookOrigin ? { Origin: opts.webhookOrigin } : {}),
          ...headers,
        },
      };
      if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
      return SELF.fetch(`https://staging.serialis.dev/api/v1${path}`, init);
    },
    async query(sqlText, ...binds) {
      return runInDurableObject(stub, (_s: ShopStore, state: DurableObjectState) => state.storage.sql.exec(sqlText, ...binds).toArray()) as never;
    },
    async run(sqlText, ...binds) {
      await runInDurableObject(stub, (_s: ShopStore, state: DurableObjectState) => {
        state.storage.sql.exec(sqlText, ...binds);
      });
    },
  };
  return h;
}

export async function json<T = any>(res: Response, status?: number): Promise<T> {
  const text = await res.text();
  if (status !== undefined) expect(res.status, text).toBe(status);
  return (text ? JSON.parse(text) : null) as T;
}

/** Tracks variants through the API and returns their item rows. */
export async function track(h: Harness, variantGids: string[], applyToOpenOrders = false): Promise<void> {
  await json(await h.api('POST', '/tracked-items', { variantGids, applyToOpenOrders }), 200);
}

export async function addRefs(h: Harness, variantGid: string, locationId: string, refs: string[], alreadyCounted = false, mode: 'atomic' | 'per_item' = 'per_item') {
  return json(await h.api('POST', '/units/batch', { variantGid, locationId, refs, alreadyCounted, mode }));
}

export function sim_level(h: Harness, itemId: string, locationId: string) {
  const lv = h.sim.shop.getLevel(itemId, locationId);
  if (!lv) return { available: 0, committed: 0, on_hand: 0, quality_control: 0, damaged: 0 };
  return { ...lv.q, on_hand: h.sim.shop.quantity(lv, 'on_hand') };
}

/**
 * Invariants of 18.3: no unit engaged twice (G1), Shopify `on_hand` equal to the counted units
 * net of the explained gaps (I1), `quality_control`/`damaged` equal to the units (I5), and no
 * contract breach recorded by the simulator (null changeFromQuantity, missing @idempotent).
 */
export async function assertConsistent(h: Harness): Promise<void> {
  expect(h.sim.violations).toEqual([]);
  const twice = await h.query("SELECT unit_id, count(*) AS n FROM allocations WHERE status IN ('active', 'fulfilled') GROUP BY unit_id HAVING n > 1");
  expect(twice).toEqual([]);
  const items = await h.query<{ id: string; inventory_item_gid: string }>('SELECT id, inventory_item_gid FROM tracked_items WHERE active = 1');
  for (const item of items) {
    for (const lv of h.sim.shop.levelsOfItem(item.inventory_item_gid)) {
      const counted = await h.query<{ status: string; n: number }>('SELECT status, count(*) AS n FROM units WHERE tracked_item_id = ? AND location_id = ? GROUP BY status', item.id, lv.locationId);
      const n = (s: string[]) => counted.filter((c) => s.includes(c.status)).reduce((a, c) => a + c.n, 0);
      const explained = await h.query<{ direction: string; q: number }>(
        "SELECT direction, SUM(quantity) AS q FROM explained_quantities WHERE tracked_item_id = ? AND location_id = ? AND status = 'open' GROUP BY direction",
        item.id,
        lv.locationId,
      );
      const surplus = explained.find((e) => e.direction === 'surplus')?.q ?? 0;
      // 8.1: units to verify explain a gap where Shopify counts more (it may have restocked them).
      const deficit = (explained.find((e) => e.direction === 'deficit')?.q ?? 0) + n(['TO_VERIFY']);
      const onHand = h.sim.shop.quantity(lv, 'on_hand');
      const units = n(['AVAILABLE', 'HELD', 'ALLOCATED', 'QUALITY_CONTROL', 'DAMAGED']);
      expect(Math.abs(onHand - units), `I1 at ${lv.locationId}: on_hand ${onHand}, units ${units}`).toBeLessThanOrEqual(onHand > units ? deficit : surplus);
      expect(lv.q.quality_control, 'I5 quality_control').toBe(n(['QUALITY_CONTROL']));
      expect(lv.q.damaged, 'I5 damaged').toBe(n(['DAMAGED']));
    }
  }
}

export async function anomalies(h: Harness, type?: string, status: 'live' | 'all' = 'live') {
  const rows = await h.query<{ id: string; type: string; status: string; details: string; subject: string; severity: string }>(
    `SELECT * FROM anomalies ${status === 'live' ? "WHERE status IN ('open', 'acknowledged')" : ''} ORDER BY detected_at`,
  );
  return rows.filter((r) => !type || r.type === type);
}

export function metafieldOf(h: Harness, orderId: string): { version: number; lines: Array<{ line_item_id: string; units: Array<{ unit_id: string; status: string; identifiers: Array<{ value: string }> }> }> } | null {
  const mf = h.sim.shop.order(orderId).metafields.find((m) => m.namespace === 'serialis' && m.key === 'units');
  return mf ? JSON.parse(mf.value) : null;
}
