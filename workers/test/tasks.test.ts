import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerTaskHandler } from '../src/handlers.js';
import type { ShopStore } from '../src/shop-store.js';
import { COALESCE_MAX_MS, MAX_ATTEMPTS, RETRY_BASE_MS, type TaskRow } from '../src/tasks.js';
import { gid, topicAction } from '../src/topics.js';
import { installShop, sendWebhook } from './helpers.js';

const restorers: Array<() => void> = [];
afterEach(() => {
  while (restorers.length) restorers.pop()!();
  vi.restoreAllMocks();
});

function handle(kind: string, handler: Parameters<typeof registerTaskHandler>[1]) {
  restorers.push(registerTaskHandler(kind, handler));
}

async function tasks(stub: DurableObjectStub<ShopStore>): Promise<TaskRow[]> {
  return runInDurableObject(stub, (_s: ShopStore, state: DurableObjectState) => state.storage.sql.exec<TaskRow>("SELECT * FROM tasks WHERE key NOT IN ('purge', 'recon:R4') ORDER BY key").toArray());
}

/** Makes every pending task due, then runs the alarm now (armed in the future so that it cannot fire by itself first). */
async function fireDue(stub: DurableObjectStub<ShopStore>): Promise<void> {
  await runInDurableObject(stub, async (_s: ShopStore, state: DurableObjectState) => {
    state.storage.sql.exec("UPDATE tasks SET run_at = 0 WHERE status = 'pending' AND key NOT IN ('purge', 'recon:R4')");
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

describe('topic → task mapping (spec 12.1, 12.2)', () => {
  it('maps order, fulfillment, refund, return and inventory topics', () => {
    expect(topicAction('orders/create', { id: 12 })).toMatchObject({ type: 'task', key: 'sync_order:gid://shopify/Order/12', kind: 'sync_order' });
    expect(topicAction('orders/updated', { admin_graphql_api_id: 'gid://shopify/Order/13', id: 13 })).toMatchObject({ key: 'sync_order:gid://shopify/Order/13' });
    expect(topicAction('fulfillments/create', { id: 1, order_id: 14 })).toMatchObject({ key: 'sync_order:gid://shopify/Order/14' });
    expect(topicAction('refunds/create', { id: 1, order_id: 15 })).toMatchObject({ key: 'sync_order:gid://shopify/Order/15' });
    expect(topicAction('returns/request', { id: 3, order: { id: 16, admin_graphql_api_id: 'gid://shopify/Order/16' } })).toMatchObject({ key: 'sync_order:gid://shopify/Order/16' });
    // No order id in the body: light resolve task (spec 12.1).
    expect(topicAction('returns/update', { admin_graphql_api_id: 'gid://shopify/Return/3' })).toMatchObject({ key: 'resolve:gid://shopify/Return/3', kind: 'resolve' });
    expect(topicAction('reverse_fulfillment_orders/dispose', { id: 8 })).toMatchObject({ key: 'resolve:gid://shopify/ReverseFulfillmentOrder/8' });
    expect(topicAction('fulfillment_orders/moved', { original_fulfillment_order: { id: 'gid://shopify/FulfillmentOrder/4' } })).toMatchObject({ key: 'resolve:gid://shopify/FulfillmentOrder/4' });
    expect(topicAction('inventory_levels/update', { inventory_item_id: 21, location_id: 31 })).toMatchObject({ key: 'inv:21:31', kind: 'sync_inventory_level' });
    expect(topicAction('products/update', { id: 41 })).toMatchObject({ key: 'product:41', kind: 'sync_product' });
    expect(topicAction('locations/update', { id: 51 })).toMatchObject({ key: 'location:51', kind: 'sync_location' });
    expect(topicAction('customers/data_request', { orders_requested: [1, 2], data_request: { id: 99 }, customer: { email: 'x' } })).toEqual({
      type: 'compliance',
      topic: 'customers/data_request',
      orderGids: ['gid://shopify/Order/1', 'gid://shopify/Order/2'],
      dataRequestId: '99',
    });
    expect(topicAction('app/uninstalled', {})).toEqual({ type: 'uninstall' });
    expect(topicAction('draft_orders/update', { id: 1 })).toMatchObject({ type: 'none' });
    expect(topicAction('orders/create', {})).toMatchObject({ type: 'none' });
    expect(gid('Order', 'gid://shopify/Product/1')).toBeNull();
  });
});

describe('tasks and alarms (spec 12.2)', () => {
  it('keeps one pending sync_order per order and coalesces bursts within the deadline', async () => {
    const shop = 'dedupe-example.myshopify.com';
    const { stub } = await installShop(shop);
    await sendWebhook({ shop, topic: 'orders/create', body: { id: 7 } });
    const [first] = await tasks(stub);
    await sendWebhook({ shop, topic: 'orders/updated', body: { id: 7 } });
    await sendWebhook({ shop, topic: 'fulfillments/create', body: { id: 70, order_id: 7 } });
    const rows = await tasks(stub);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ key: 'sync_order:gid://shopify/Order/7', kind: 'sync_order', status: 'pending', attempts: 0 });
    expect(row!.run_at).toBeGreaterThanOrEqual(first!.run_at);
    expect(row!.run_at).toBeLessThanOrEqual(row!.deadline_at);
    expect(row!.deadline_at).toBe(first!.deadline_at);
    expect(row!.deadline_at - first!.created_at).toBe(COALESCE_MAX_MS);
    // Alarm on the smallest run_at.
    await runInDurableObject(stub, async (_s: ShopStore, state: DurableObjectState) => {
      expect(await state.storage.getAlarm()).toBe(row!.run_at);
    });
  });

  it('runs due tasks from the alarm and deletes them on success', async () => {
    const shop = 'run-example.myshopify.com';
    const seen: string[] = [];
    handle('sync_order', (ctx) => {
      seen.push(`${ctx.key}#${ctx.attempt}`);
    });
    const { stub } = await installShop(shop);
    await sendWebhook({ shop, topic: 'orders/create', body: { id: 8 } });
    await fireDue(stub);
    expect(seen).toEqual(['sync_order:gid://shopify/Order/8#1']);
    expect(await tasks(stub)).toEqual([]);
    await runInDurableObject(stub, async (_s: ShopStore, state: DurableObjectState) => {
      // Only the daily maintenance (purge, R4) is left: the alarm is set on its next run.
      const next = state.storage.sql.exec<{ at: number }>("SELECT MIN(run_at) AS at FROM tasks WHERE key IN ('purge', 'recon:R4')").one().at;
      expect(await state.storage.getAlarm()).toBe(next);
    });
  });

  it('retries with exponential backoff and jitter, then dead after the maximum attempts', async () => {
    const shop = 'retry-example.myshopify.com';
    handle('sync_order', () => {
      throw new Error('boom');
    });
    const { stub } = await installShop(shop);
    await sendWebhook({ shop, topic: 'orders/create', body: { id: 9 } });

    const before = Date.now();
    await fireDue(stub);
    let [row] = await tasks(stub);
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error: 'Error: boom' });
    // attempt 1: base × [0.5, 1]
    expect(row!.run_at - before).toBeGreaterThanOrEqual(RETRY_BASE_MS * 0.5);
    expect(row!.run_at - Date.now()).toBeLessThanOrEqual(RETRY_BASE_MS);
    await runInDurableObject(stub, async (_s: ShopStore, state: DurableObjectState) => {
      expect(await state.storage.getAlarm()).toBe(row!.run_at);
    });

    await fireDue(stub);
    [row] = await tasks(stub);
    expect(row!.attempts).toBe(2);
    expect(row!.run_at - Date.now()).toBeGreaterThanOrEqual(RETRY_BASE_MS - 50); // 2 × base × [0.5, 1]

    for (let i = 3; i <= MAX_ATTEMPTS; i++) await fireDue(stub);
    [row] = await tasks(stub);
    expect(row).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS });
    // A dead task is not revived by a new webhook (only R2 does it), and no alarm stays armed for it.
    await sendWebhook({ shop, topic: 'orders/updated', body: { id: 9 } });
    expect((await tasks(stub))[0]!.status).toBe('dead');
    expect(await stub.reviveTask('sync_order:gid://shopify/Order/9')).toBe(true);
    expect((await tasks(stub))[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('reruns at once when a request arrives during the execution', async () => {
    const shop = 'rerun-example.myshopify.com';
    const { stub } = await installShop(shop);
    let instance!: ShopStore;
    let storage!: DurableObjectStorage;
    await runInDurableObject(stub, (store: ShopStore, state: DurableObjectState) => {
      instance = store;
      storage = state.storage;
    });
    let runs = 0;
    let observed: TaskRow | undefined;
    handle('sync_order', async () => {
      runs += 1;
      if (runs === 1) {
        // A webhook for the same order lands while the task runs (same object, interleaved).
        await instance.ingest({ webhookId: 'during-run', topic: 'orders/updated', triggeredAt: null, payload: '{"id":10}' });
        observed = storage.sql.exec<TaskRow>("SELECT * FROM tasks WHERE key NOT IN ('purge', 'recon:R4')").toArray()[0];
      }
    });
    await sendWebhook({ shop, topic: 'orders/create', body: { id: 10 } });
    await fireDue(stub);
    expect(observed).toMatchObject({ status: 'running', rerun_requested: 1 });
    // Rescheduled at once instead of closed: the same alarm run picks it up again.
    expect(runs).toBe(2);
    expect(await tasks(stub)).toEqual([]);
  });

  it('recovers a task whose lease expired, and kills a kind without handler', async () => {
    const shop = 'lease-example.myshopify.com';
    let ran = 0;
    handle('sync_product', () => {
      ran += 1;
    });
    const { stub } = await installShop(shop);
    await stub.enqueueTask({ key: 'mystery:1', kind: 'mystery', priority: 50, delayMs: 60_000 });
    await runInDurableObject(stub, (_s: ShopStore, state: DurableObjectState) => {
      const now = Date.now();
      // An execution interrupted by an eviction: running, lease expired.
      state.storage.sql.exec(
        "INSERT INTO tasks (key, kind, payload, run_at, deadline_at, status, lease_until, lease_token, attempts, priority, created_at, updated_at) VALUES ('product:1', 'sync_product', '{}', ?, ?, 'running', ?, 'old', 1, 30, ?, ?)",
        now - 10_000,
        now,
        now - 1,
        now,
        now,
      );
      state.storage.sql.exec("UPDATE tasks SET run_at = 0 WHERE key = 'mystery:1'");
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(ran).toBe(1);
    const rows = await tasks(stub);
    expect(rows.map((r) => [r.key, r.status])).toEqual([['mystery:1', 'dead']]);
    expect(rows[0]!.last_error).toContain('no handler');
  });

  it('never lets an exception escape the alarm', async () => {
    const shop = 'alarm-safe-example.myshopify.com';
    handle('sync_order', () => {
      throw new TypeError('unexpected');
    });
    const { stub } = await installShop(shop);
    await sendWebhook({ shop, topic: 'orders/create', body: { id: 11 } });
    await fireDue(stub); // would reject if alarm() threw
    await runInDurableObject(stub, async (_s: ShopStore, state: DurableObjectState) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});
