import { newUuid } from './uuid';
import {
  INTERNAL_BASE,
  type CreateAllocationRequest,
  type CreateUnitsBatchRequest,
  type CheckUnitsBatchResponse,
  type CreateUnitsBatchResponse,
  type ErrorCode,
  type Gid,
  type ListLocationsResponse,
  type ListTrackedItemsQuery,
  type ListUnitsQuery,
  type LookupResponse,
  type OrderAllocationsResponse,
  type Allocation,
  type Page,
  type Problem,
  type ReplaceAllocationRequest,
  type TrackItemsRequest,
  type TrackItemsResponse,
  type TrackedItem,
  type Unit,
  type UntrackItemsRequest,
} from '@serialis/contract';
import { gidToId } from './ids';

/** Error codes of the contract plus the two raised by the client itself. */
export type ClientErrorCode = ErrorCode | 'network_error' | 'unknown';

/** Failure of an API call: either a problem+json answer (RFC 9457) or a transport failure. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly problem: Problem | null;
  constructor(status: number, code: ClientErrorCode, message: string, problem: Problem | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.problem = problem;
  }
  /** Detail given by the server, if any (shown after the translated message). */
  get detail(): string | undefined {
    return this.problem?.detail;
  }
}

export interface ApiClientOptions {
  /**
   * The extension's authenticated `fetch`: in an admin extension the global `fetch` resolves relative URLs
   * against the app's `application_url` and adds the Authorization header (shopify.dev, "network features").
   */
  fetch?: typeof fetch;
  /** Defaults to the internal base of the contract (`/api/v1`). */
  baseUrl?: string;
  /** Source of Idempotency-Key values (defaults to `newUuid`, which falls back to `crypto.getRandomValues`). */
  newIdempotencyKey?: () => string;
}

/** Optional per-call settings. `idempotencyKey` lets a retry reuse the key of the first attempt (15.5, "Envois sûrs"). */
export interface CallOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

function randomKey(): string {
  return newUuid();
}

function queryString(params: Record<string, string | number | string[] | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) sp.append(k, item);
    } else {
      sp.set(k, String(v));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function createApiClient(options: ApiClientOptions = {}) {
  const base = (options.baseUrl ?? INTERNAL_BASE).replace(/\/$/, '');
  const newKey = options.newIdempotencyKey ?? randomKey;
  // Resolved lazily so that a test can stub the global before the first call.
  const doFetch = (input: string, init: RequestInit): Promise<Response> =>
    (options.fetch ?? globalThis.fetch)(input, init);

  async function request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
    call: CallOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json, application/problem+json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method === 'POST') headers['Idempotency-Key'] = call.idempotencyKey ?? newKey();
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (call.signal) init.signal = call.signal;

    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, init);
    } catch (cause) {
      if (call.signal?.aborted) throw cause;
      throw new ApiError(0, 'network_error', cause instanceof Error ? cause.message : 'network error');
    }
    if (res.status === 204) return undefined as T;
    if (res.ok) {
      try {
        return (await res.json()) as T;
      } catch {
        throw new ApiError(res.status, 'unknown', 'Invalid JSON in a successful response');
      }
    }
    throw await toApiError(res);
  }

  return {
    // --- tracked items -------------------------------------------------
    listTrackedItems: (q: ListTrackedItemsQuery = {}, call?: CallOptions) =>
      request<Page<TrackedItem>>('GET', `/tracked-items${queryString({ ...q })}`, undefined, call),
    trackVariants: (variantGids: Gid[], extra: Omit<TrackItemsRequest, 'variantGids'> = {}, call?: CallOptions) =>
      request<TrackItemsResponse>('POST', '/tracked-items', { variantGids, ...extra } satisfies TrackItemsRequest, call),
    untrackVariants: (variantGids: Gid[], call?: CallOptions) =>
      request<TrackItemsResponse>('POST', '/tracked-items', { action: 'untrack', variantGids } satisfies UntrackItemsRequest, call),

    // --- locations ------------------------------------------------------
    listLocations: (call?: CallOptions) => request<ListLocationsResponse>('GET', '/locations', undefined, call),

    // --- units ----------------------------------------------------------
    listUnits: (q: ListUnitsQuery = {}, call?: CallOptions) =>
      request<Page<Unit>>('GET', `/units${queryString({ ...q, state: q.state })}`, undefined, call),
    /** Follows `nextCursor` up to `maxPages` pages; `truncated` is true when more pages exist. */
    async listAllUnits(
      q: Omit<ListUnitsQuery, 'cursor'>,
      opts: { maxPages?: number; signal?: AbortSignal } = {},
    ): Promise<{ items: Unit[]; truncated: boolean }> {
      const maxPages = opts.maxPages ?? 8;
      const items: Unit[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const q2: ListUnitsQuery = { limit: 250, ...q };
        if (cursor !== undefined) q2.cursor = cursor;
        const res = await request<Page<Unit>>('GET', `/units${queryString({ ...q2 })}`, undefined, opts.signal ? { signal: opts.signal } : {});
        items.push(...res.items);
        if (!res.nextCursor) return { items, truncated: false };
        cursor = res.nextCursor;
      }
      return { items, truncated: true };
    },
    createUnitsBatch: (req: CreateUnitsBatchRequest, call?: CallOptions) =>
      request<CreateUnitsBatchResponse>('POST', '/units/batch', req, call),
    /** Row-by-row check of a batch, nothing written (`already_known` follows the uniqueness scope S-35). */
    checkUnitsBatch: (req: CreateUnitsBatchRequest, call?: CallOptions) =>
      request<CheckUnitsBatchResponse>('POST', '/units/batch/check', req, call),
    /** Unit carrying an identifier (any variant of the shop), or null. */
    lookup: (identifier: string, call?: CallOptions) =>
      request<LookupResponse>('GET', `/lookup${queryString({ identifier })}`, undefined, call),

    // --- orders and allocations ----------------------------------------
    /** `orderGid` may be a GID or a bare numeric id: the route carries the numeric id (public API `{order_id}`). */
    orderAllocations: (orderGid: Gid, call?: CallOptions) =>
      request<OrderAllocationsResponse>('GET', `/orders/${encodeURIComponent(gidToId(orderGid))}/allocations`, undefined, call),
    createAllocation: (req: CreateAllocationRequest, call?: CallOptions) =>
      request<Allocation>('POST', '/allocations', req, call),
    replaceAllocation: (id: string, req: ReplaceAllocationRequest, call?: CallOptions) =>
      request<Allocation>('POST', `/allocations/${encodeURIComponent(id)}/replace`, req, call),
    deleteAllocation: (id: string, call?: CallOptions) =>
      request<void>('DELETE', `/allocations/${encodeURIComponent(id)}`, undefined, call),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

async function toApiError(res: Response): Promise<ApiError> {
  let problem: Problem | null = null;
  try {
    const json: unknown = await res.json();
    if (json && typeof json === 'object' && typeof (json as Problem).code === 'string') problem = json as Problem;
  } catch {
    /* not JSON: fall through to the status mapping */
  }
  if (problem) return new ApiError(res.status, problem.code, problem.title || problem.code, problem);
  // 412 without body: modification conflict (15.7).
  const code: ClientErrorCode =
    res.status === 412 ? 'precondition_failed'
    : res.status === 401 ? 'unauthenticated'
    : res.status === 403 ? 'forbidden'
    : res.status === 404 ? 'not_found'
    : res.status === 429 ? 'rate_limited'
    : 'unknown';
  return new ApiError(res.status, code, `HTTP ${res.status}`);
}
