import { describe, expect, it } from 'vitest';
import type { Unit } from '@serialis/contract';
import { ApiError, createApiClient } from '../src';
import { json, mockFetch, problem } from '../src/testing';

const unit = (id: string): Unit => ({
  id, variantGid: 'gid://shopify/ProductVariant/1', locationId: 'loc1', state: 'AVAILABLE', identifiers: [],
  ref: `REF-${id}`, receivedAt: null, orderGid: null, version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});

describe('createApiClient', () => {
  it('calls the internal base with relative URLs, no Idempotency-Key on GET', async () => {
    const m = mockFetch({ 'GET /api/v1/locations': () => ({ items: [], nextCursor: null }) });
    const api = createApiClient({ fetch: m.fetch });
    await api.listLocations();
    expect(m.calls[0]!.url).toBe('/api/v1/locations');
    expect(m.calls[0]!.headers['idempotency-key']).toBeUndefined();
    expect(m.calls[0]!.headers['accept']).toContain('application/json');
  });

  it('names the extension target on every call, from the shopify global by default (T-UX-08, recette 2)', async () => {
    const m = mockFetch({ 'GET /api/v1/locations': () => ({ items: [], nextCursor: null }) });
    const g = globalThis as { shopify?: unknown };
    const before = g.shopify;
    g.shopify = { extension: { target: 'admin.order-details.action.render' } };
    try {
      await createApiClient({ fetch: m.fetch }).listLocations();
      await createApiClient({ fetch: m.fetch, extensionTarget: 'admin.product-variant-details.action.render' }).listLocations();
      g.shopify = undefined;
      await createApiClient({ fetch: m.fetch }).listLocations();
    } finally {
      g.shopify = before;
    }
    expect(m.calls.map((c) => c.headers['x-serialis-extension'])).toEqual(['admin.order-details.action.render', 'admin.product-variant-details.action.render', undefined]);
  });

  it('sends an Idempotency-Key on every POST, fresh by default and reusable on retry', async () => {
    let n = 0;
    const m = mockFetch({ 'POST /api/v1/units/batch': () => ({ created: [], rejected: [] }) });
    const api = createApiClient({ fetch: m.fetch, newIdempotencyKey: () => `key-${++n}` });
    const req = { variantGid: 'gid://shopify/ProductVariant/1', locationId: 'l', refs: ['A'], alreadyCounted: false, mode: 'per_item' as const };
    await api.createUnitsBatch(req);
    await api.createUnitsBatch(req);
    await api.createUnitsBatch(req, { idempotencyKey: 'same' });
    await api.createUnitsBatch(req, { idempotencyKey: 'same' });
    expect(m.calls.map((c) => c.headers['idempotency-key'])).toEqual(['key-1', 'key-2', 'same', 'same']);
    expect(m.calls[0]!.headers['content-type']).toBe('application/json');
    expect(m.calls[0]!.body).toEqual(req);
  });

  it('puts track and untrack on POST /tracked-items', async () => {
    const m = mockFetch({ 'POST /api/v1/tracked-items': () => ({ items: [], nextCursor: null }) });
    const api = createApiClient({ fetch: m.fetch });
    await api.trackVariants(['gid://shopify/ProductVariant/1']);
    await api.untrackVariants(['gid://shopify/ProductVariant/1']);
    expect(m.calls[0]!.body).toEqual({ variantGids: ['gid://shopify/ProductVariant/1'] });
    expect(m.calls[1]!.body).toEqual({ action: 'untrack', variantGids: ['gid://shopify/ProductVariant/1'] });
  });

  it('builds the query string, including repeated state values', async () => {
    const m = mockFetch({ 'GET /api/v1/units': () => ({ items: [], nextCursor: null }) });
    const api = createApiClient({ fetch: m.fetch });
    await api.listUnits({ variant: 'gid://shopify/ProductVariant/1', state: ['AVAILABLE', 'HELD'], limit: 50 });
    const q = m.calls[0]!.query;
    expect(q.get('variant')).toBe('gid://shopify/ProductVariant/1');
    expect(q.getAll('state')).toEqual(['AVAILABLE', 'HELD']);
    expect(q.get('limit')).toBe('50');
    expect(q.has('cursor')).toBe(false);
  });

  it('uses the numeric order id in the allocations route', async () => {
    const m = mockFetch({ 'GET /api/v1/orders/42/allocations': () => ({ orderGid: 'gid://shopify/Order/42', lines: [], syncState: 'synced', syncedAt: null }) });
    const api = createApiClient({ fetch: m.fetch });
    await api.orderAllocations('gid://shopify/Order/42');
    expect(m.calls[0]!.pathname).toBe('/api/v1/orders/42/allocations');
  });

  it('handles allocation routes: create, replace, delete (204)', async () => {
    const m = mockFetch({
      'POST /api/v1/allocations': () => ({ id: 'a1' }),
      'POST /api/v1/allocations/a1/replace': () => ({ id: 'a1' }),
      'DELETE /api/v1/allocations/a1': () => undefined,
    });
    const api = createApiClient({ fetch: m.fetch });
    await api.createAllocation({ orderGid: 'o', lineItemGid: 'l', unitId: 'u' });
    await api.replaceAllocation('a1', { ref: 'ABCD' });
    await expect(api.deleteAllocation('a1')).resolves.toBeUndefined();
    expect(m.calls[1]!.body).toEqual({ ref: 'ABCD' });
    expect(m.calls[2]!.headers['idempotency-key']).toBeUndefined();
  });

  it('follows pagination in listAllUnits and reports truncation at the page cap', async () => {
    const pages: Record<string, { items: Unit[]; nextCursor: string | null }> = {
      '': { items: [unit('1'), unit('2')], nextCursor: 'c1' },
      c1: { items: [unit('3')], nextCursor: 'c2' },
      c2: { items: [unit('4')], nextCursor: null },
    };
    const m = mockFetch({ 'GET /api/v1/units': (c) => pages[c.query.get('cursor') ?? '']! });
    const api = createApiClient({ fetch: m.fetch });
    const all = await api.listAllUnits({ variant: 'v' });
    expect(all.items.map((u) => u.id)).toEqual(['1', '2', '3', '4']);
    expect(all.truncated).toBe(false);
    expect(m.calls[0]!.query.get('limit')).toBe('250');

    const capped = await api.listAllUnits({ variant: 'v' }, { maxPages: 2 });
    expect(capped.items).toHaveLength(3);
    expect(capped.truncated).toBe(true);
  });

  it('turns problem+json into an ApiError with code, status and detail', async () => {
    const m = mockFetch({ 'POST /api/v1/allocations': () => problem(409, 'unit_not_available', 'Allocated to order #1042') });
    const api = createApiClient({ fetch: m.fetch });
    const err = await api.createAllocation({ orderGid: 'o', lineItemGid: 'l', unitId: 'u' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect([e.status, e.code, e.detail]).toEqual([409, 'unit_not_available', 'Allocated to order #1042']);
    expect(e.problem?.title).toBe('unit_not_available');
  });

  it.each([
    [412, 'precondition_failed'],
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'unknown'],
  ] as const)('maps a body-less HTTP %i to %s', async (status, code) => {
    const m = mockFetch({ 'GET /api/v1/locations': () => new Response('oops', { status }) });
    const err = (await createApiClient({ fetch: m.fetch }).listLocations().catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
  });

  it('reports a transport failure as network_error', async () => {
    const api = createApiClient({ fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch });
    const err = (await api.listLocations().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('network_error');
  });

  it('rethrows an aborted call as is', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchMock = ((_: string, init: RequestInit) => Promise.reject(init.signal?.reason)) as unknown as typeof fetch;
    const err = await createApiClient({ fetch: fetchMock }).listLocations({ signal: ctrl.signal }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ApiError);
  });

  it('keeps problem+json item errors available', async () => {
    const m = mockFetch({
      'POST /api/v1/units/batch': () => problem(422, 'validation_failed', undefined, [{ index: 1, code: 'identifier_conflict' }]),
    });
    const err = (await createApiClient({ fetch: m.fetch })
      .createUnitsBatch({ variantGid: 'v', locationId: 'l', refs: ['a', 'b'], alreadyCounted: false, mode: 'atomic' })
      .catch((e: unknown) => e)) as ApiError;
    expect(err.problem?.errors?.[0]?.code).toBe('identifier_conflict');
  });

  it('uses the global fetch when none is given', async () => {
    const m = mockFetch({ 'GET /api/v1/locations': () => json({ items: [], nextCursor: null }) });
    const original = globalThis.fetch;
    globalThis.fetch = m.fetch;
    try {
      await createApiClient().listLocations();
    } finally {
      globalThis.fetch = original;
    }
    expect(m.calls).toHaveLength(1);
  });

  it('recette 3 — order allocations are polled with If-None-Match; a 304 hands back the same data', async () => {
    let n = 0;
    const m = mockFetch({
      'GET /api/v1/orders/42/allocations': (c) =>
        c.headers['if-none-match'] === 'W/"o1"' ? new Response(null, { status: 304, headers: { ETag: 'W/"o1"' } }) : json({ orderGid: 'x', n: ++n }, 200, { ETag: 'W/"o1"' }),
    });
    const api = createApiClient({ fetch: m.fetch });
    const first = await api.orderAllocations('gid://shopify/Order/42');
    const second = await api.orderAllocations('gid://shopify/Order/42');
    expect(m.calls[0]!.headers['if-none-match']).toBeUndefined();
    expect(m.calls[1]!.headers['if-none-match']).toBe('W/"o1"');
    expect(second).toBe(first);
  });
});
