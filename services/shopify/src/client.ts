import { ShopifyError, type ShopifyErrorKind } from './errors.js';
import { CostThrottle, type ThrottleStatus } from './throttle.js';
import { backoffDelay, defaultSleep, isValidShopDomain, type Sleep } from './util.js';

/** Target Admin API version (spec 13). */
export const ADMIN_API_VERSION = '2026-10';

export interface GraphqlCost {
  requestedQueryCost?: number;
  actualQueryCost?: number | null;
  throttleStatus?: ThrottleStatus;
}

export interface GraphqlResult<TData> {
  data: TData;
  extensions?: { cost?: GraphqlCost } & Record<string, unknown>;
}

export interface GraphqlErrorItem {
  message: string;
  extensions?: { code?: string } & Record<string, unknown>;
  path?: ReadonlyArray<string | number>;
}

/** Events for metrics and logs; they never carry tokens, queries or variables. */
export type ClientEvent =
  | { type: 'throttle_wait'; ms: number; reason: 'bucket' | 'throttled' }
  | { type: 'retry'; attempt: number; kind: ShopifyErrorKind; delayMs: number }
  | { type: 'response'; status: number; actualCost: number | null; ms: number };

export interface AdminClientOptions {
  shop: string;
  /** A token, or a provider called before each attempt (the shop's object refreshes it when needed). */
  accessToken: string | (() => Promise<string>);
  apiVersion?: string;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Per-shop cost bucket; share one instance between all clients of a shop. */
  throttle?: CostThrottle;
  /** Cost assumed for a request before Shopify reports it (default 50, spec 12.8 order read). */
  defaultEstimatedCost?: number;
  /** Retries on network errors and 5xx (default 4). THROTTLED replies do not count. */
  maxRetries?: number;
  /** Upper bound on THROTTLED / 429 replays, to never loop forever (default 20). */
  maxThrottleRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  sleep?: Sleep;
  now?: () => number;
  random?: () => number;
  onEvent?: (event: ClientEvent) => void;
}

export interface RequestOptions {
  variables?: Record<string, unknown>;
  /** Expected cost in points, for the bucket check before sending. */
  estimatedCost?: number;
}

/**
 * Admin GraphQL client (spec 12.4, 12.8, 13): cost-based throttling from `extensions.cost.throttleStatus`,
 * retries with exponential backoff and jitter on network errors, 5xx and THROTTLED, typed errors.
 * Logs and errors never contain the token, the query or the variables.
 */
export class AdminGraphqlClient {
  readonly shop: string;
  readonly throttle: CostThrottle;
  private readonly endpoint: string;
  private readonly options: AdminClientOptions;
  private readonly doFetch: (input: string, init: RequestInit) => Promise<Response>;
  private readonly sleep: Sleep;
  private readonly now: () => number;

  constructor(options: AdminClientOptions) {
    if (!isValidShopDomain(options.shop)) throw new ShopifyError('http', 'invalid shop domain');
    this.shop = options.shop;
    this.options = options;
    this.endpoint = `https://${options.shop}/admin/api/${options.apiVersion ?? ADMIN_API_VERSION}/graphql.json`;
    this.now = options.now ?? Date.now;
    this.throttle = options.throttle ?? new CostThrottle({ now: this.now });
    // Resolved at call time so that a test stub of the global fetch applies.
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
  }

  async request<TData = Record<string, unknown>>(query: string, requestOptions: RequestOptions = {}): Promise<GraphqlResult<TData>> {
    const maxRetries = this.options.maxRetries ?? 4;
    const maxThrottleRetries = this.options.maxThrottleRetries ?? 20;
    let estimatedCost = requestOptions.estimatedCost ?? this.options.defaultEstimatedCost ?? 50;
    let failures = 0;
    let throttled = 0;

    for (;;) {
      const wait = this.throttle.waitTimeFor(estimatedCost);
      if (wait > 0) {
        this.emit({ type: 'throttle_wait', ms: wait, reason: 'bucket' });
        await this.sleep(wait);
      }
      this.throttle.reserve(estimatedCost);

      // A failure of the token provider (reconnect required…) propagates as is.
      const outcome = await this.attempt<TData>(query, requestOptions.variables);
      if (outcome.ok) return outcome.result;

      const error = outcome.error;
      if (error.kind === 'throttled') {
        throttled += 1;
        if (throttled > maxThrottleRetries) throw error;
        if (outcome.requestedCost) estimatedCost = outcome.requestedCost;
        // Wait for the bucket (updated from the response) or for Retry-After, whichever is longer.
        const delay = Math.max(outcome.retryAfterMs ?? 0, this.throttle.waitTimeFor(estimatedCost), 250);
        this.emit({ type: 'throttle_wait', ms: delay, reason: 'throttled' });
        await this.sleep(delay);
        continue;
      }
      if (error.retryable && failures < maxRetries) {
        failures += 1;
        const delay = backoffDelay(failures, {
          baseMs: this.options.retryBaseMs ?? 500,
          maxMs: this.options.retryMaxMs ?? 30_000,
          ...(this.options.random ? { random: this.options.random } : {}),
        });
        this.emit({ type: 'retry', attempt: failures, kind: error.kind, delayMs: delay });
        await this.sleep(delay);
        continue;
      }
      throw error;
    }
  }

  private async attempt<TData>(query: string, variables: Record<string, unknown> | undefined): Promise<Outcome<TData>> {
    const token = typeof this.options.accessToken === 'string' ? this.options.accessToken : await this.options.accessToken();
    const started = this.now();
    let response: Response;
    try {
      response = await this.doFetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify(variables ? { query, variables } : { query }),
      });
    } catch (cause) {
      return { ok: false, error: new ShopifyError('network', 'Shopify Admin API unreachable', { cause }) };
    }

    if (response.status === 429) {
      await discard(response);
      return { ok: false, error: new ShopifyError('throttled', 'Shopify answered 429', { status: 429 }), retryAfterMs: retryAfter(response) };
    }
    if (response.status >= 500) {
      await discard(response);
      return { ok: false, error: new ShopifyError('server', `Shopify answered ${response.status}`, { status: response.status }) };
    }
    if (!response.ok) {
      await discard(response);
      return { ok: false, error: new ShopifyError(httpKind(response.status), `Shopify answered ${response.status}`, { status: response.status }) };
    }

    let body: { data?: TData; errors?: GraphqlErrorItem[]; extensions?: GraphqlResult<TData>['extensions'] };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      return { ok: false, error: new ShopifyError('invalid_response', 'Shopify answered without JSON', { status: response.status }) };
    }
    const cost = body.extensions?.cost;
    if (cost?.throttleStatus) this.throttle.update(cost.throttleStatus);
    this.emit({ type: 'response', status: response.status, actualCost: cost?.actualQueryCost ?? null, ms: this.now() - started });

    if (body.errors && body.errors.length > 0) {
      const codes = body.errors.map((e) => e.extensions?.code).filter((c): c is string => typeof c === 'string');
      if (codes.includes('THROTTLED')) {
        return {
          ok: false,
          error: new ShopifyError('throttled', 'Shopify answered THROTTLED', { status: response.status, codes }),
          ...(cost?.requestedQueryCost ? { requestedCost: cost.requestedQueryCost } : {}),
        };
      }
      if (codes.includes('INTERNAL_SERVER_ERROR')) {
        return { ok: false, error: new ShopifyError('server', 'Shopify GraphQL internal error', { status: response.status, codes }) };
      }
      // Messages from Shopify describe the query, not its variables: kept, truncated.
      const message = body.errors.map((e) => e.message).join('; ').slice(0, 300);
      return { ok: false, error: new ShopifyError('graphql', `GraphQL errors: ${message}`, { status: response.status, codes }) };
    }
    if (body.data === undefined || body.data === null) {
      return { ok: false, error: new ShopifyError('invalid_response', 'GraphQL response without data', { status: response.status }) };
    }
    return { ok: true, result: { data: body.data, ...(body.extensions ? { extensions: body.extensions } : {}) } };
  }

  private emit(event: ClientEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // Observability must never break a request.
    }
  }
}

type Outcome<TData> =
  | { ok: true; result: GraphqlResult<TData> }
  | { ok: false; error: ShopifyError; retryAfterMs?: number | undefined; requestedCost?: number };

function httpKind(status: number): ShopifyErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || status === 423) return 'frozen';
  if (status === 404) return 'not_found';
  return 'http';
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('Retry-After');
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

/** Returns the `userErrors` of the first mutation field of a response, if any (helper for the outbox). */
export function firstUserErrors(data: unknown): Array<{ code?: string | null; message: string; field?: unknown }> {
  if (!data || typeof data !== 'object') return [];
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (value && typeof value === 'object' && Array.isArray((value as { userErrors?: unknown }).userErrors)) {
      return (value as { userErrors: Array<{ code?: string | null; message: string; field?: unknown }> }).userErrors;
    }
  }
  return [];
}
