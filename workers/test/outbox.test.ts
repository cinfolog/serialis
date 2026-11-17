import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutboxRow } from '../src/outbox.js';
import type { ShopStore } from '../src/shop-store.js';
import { installShop, json, mockShopify } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const ADJUST = `mutation Adjust($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) { userErrors { code message } }
}`;
const METAFIELD = `mutation Set($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { code message } } }`;

function ok(field = 'inventoryAdjustQuantities') {
  return json({ data: { [field]: { userErrors: [] } }, extensions: { cost: { requestedQueryCost: 10, actualQueryCost: 10, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1990, restoreRate: 100 } } } });
}

function userError(code: string, field = 'inventoryAdjustQuantities') {
  return json({ data: { [field]: { userErrors: [{ code, message: code.toLowerCase() }] } } });
}

async function installWithToken(shop: string) {
  const { routing, stub } = await installShop(shop);
  await stub.install({ shopDomain: shop, objectName: routing.objectName, sessionToken: 'jwt' });
  return stub;
}

async function rows(stub: DurableObjectStub<ShopStore>): Promise<OutboxRow[]> {
  return runInDurableObject(stub, (_s: ShopStore, state: DurableObjectState) => state.storage.sql.exec<OutboxRow>('SELECT * FROM outbox ORDER BY id').toArray());
}

const input = { delta: -1, inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/1' };

describe('outbox (spec 12.4)', () => {
  it('dedupes enqueues and resends the same frozen payload and idempotency key until done', async () => {
    let calls = 0;
    const mock = mockShopify({
      graphql: () => {
        calls += 1;
        // First attempt: unreadable answer (the write may or may not have happened).
        return calls === 1 ? new Response('<html>gateway</html>', { status: 200 }) : ok();
      },
    });
    const stub = await installWithToken('outbox-example.myshopify.com');
    const write = { kind: 'inventory_adjust' as const, serialKey: 'inv:1:1', query: ADJUST, variables: { input }, dedupeKey: 'adjust:unit-1:v1' };
    const first = await stub.enqueueOutbox(write);
    const again = await stub.enqueueOutbox(write);
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });

    await vi.waitFor(async () => expect((await rows(stub))[0]!.status).toBe('done'), { timeout: 4_000, interval: 50 });
    const [row] = await rows(stub);
    expect(row).toMatchObject({ attempts: 2, revision: 0 });
    expect(row!.idempotency_key).toMatch(new RegExp(`-${first.id}-r0$`));

    const sent = mock.of('graphql');
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body).toEqual(sent[1]!.body);
    expect((sent[0]!.body.variables as Record<string, unknown>).idempotencyKey).toBe(row!.idempotency_key);
    expect(sent[0]!.token).toMatch(/^shpat_test_/);

    // Enqueued again after completion: still deduped, nothing resent.
    expect(await stub.enqueueOutbox(write)).toEqual({ id: first.id, created: false });
    expect(mock.of('graphql')).toHaveLength(2);
  });

  it('moves to the next revision on IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED, fails on a business error', async () => {
    // Responses are built inside the handler: a body created in the test context cannot be read by the object.
    const replies = [() => userError('IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED'), () => ok(), () => userError('INVALID', 'metafieldsSet')];
    const mock = mockShopify({ graphql: () => (replies.shift() ?? (() => ok()))() });
    const stub = await installWithToken('revision-example.myshopify.com');
    await stub.enqueueOutbox({ kind: 'inventory_adjust', serialKey: 'inv:2:1', query: ADJUST, variables: { input } });
    await stub.enqueueOutbox({ kind: 'metafield_set', serialKey: 'order:2', query: METAFIELD, variables: { metafields: [] } });

    await vi.waitFor(async () => expect((await rows(stub)).map((r) => r.status)).toEqual(['done', 'failed']), { timeout: 4_000, interval: 50 });
    const [adjust, metafield] = await rows(stub);
    expect(adjust).toMatchObject({ revision: 1 });
    expect(adjust!.idempotency_key).toMatch(/-r1$/);
    const keys = mock.of('graphql').map((c) => (c.body.variables as Record<string, unknown>).idempotencyKey ?? null);
    expect(keys[0]).toMatch(/-r0$/);
    expect(keys.filter((k) => typeof k === 'string' && k.endsWith('-r1'))).toHaveLength(1);
    // No $idempotencyKey declared: none injected.
    expect(mock.of('graphql').some((c) => c.body.query === METAFIELD && 'idempotencyKey' in (c.body.variables as object))).toBe(false);
    expect(metafield!.last_error).toBe('INVALID: invalid');
  });

  it('keeps the order of a serial key: a dead row blocks the rows after it, other keys go on', async () => {
    const mock = mockShopify({
      graphql: (body) =>
        (body.variables as { tag?: string }).tag === 'broken'
          ? json({ errors: [{ message: "Field 'x' doesn't exist", extensions: { code: 'undefinedField' } }] })
          : ok('metafieldsSet'),
    });
    const stub = await installWithToken('serial-example.myshopify.com');
    await stub.enqueueOutbox({ kind: 'metafield_set', serialKey: 'order:3', query: METAFIELD, variables: { metafields: [], tag: 'broken' } });
    await stub.enqueueOutbox({ kind: 'metafield_set', serialKey: 'order:3', query: METAFIELD, variables: { metafields: [], tag: 'after' } });
    await stub.enqueueOutbox({ kind: 'metafield_set', serialKey: 'order:4', query: METAFIELD, variables: { metafields: [], tag: 'other' } });

    await vi.waitFor(async () => expect((await rows(stub)).map((r) => r.status)).toEqual(['dead', 'pending', 'done']), { timeout: 4_000, interval: 50 });
    const tags = mock.of('graphql').map((c) => (c.body.variables as { tag: string }).tag);
    expect(tags).toEqual(['broken', 'other']);
  });

  it('puts an in-flight row whose lease expired back to pending with the same key', async () => {
    mockShopify();
    const stub = await installWithToken('outbox-lease-example.myshopify.com');
    await runInDurableObject(stub, (store: ShopStore, state: DurableObjectState) => {
      const now = Date.now();
      state.storage.sql.exec(
        "INSERT INTO outbox (kind, serial_key, payload, idempotency_key, status, lease_until, attempts, next_attempt_at, created_at, updated_at) VALUES ('metafield_set', 'order:5', '{\"query\":\"q\",\"variables\":{}}', 'k-1-r0', 'in_flight', ?, 1, ?, ?, ?)",
        now - 1,
        now,
        now,
        now,
      );
      const recovered = (store as unknown as { outbox: { recoverExpiredLeases(): number } }).outbox.recoverExpiredLeases();
      expect(recovered).toBeGreaterThan(0); // rowsWritten also counts index entries
      expect(state.storage.sql.exec('SELECT status, idempotency_key, attempts FROM outbox').one()).toEqual({ status: 'pending', idempotency_key: 'k-1-r0', attempts: 1 });
    });
  });
});
