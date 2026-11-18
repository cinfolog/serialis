/**
 * The ONE typed client of the Serialis internal API (`/api/v1/...`, spec 14).
 *
 *  - every call goes through `HttpClient.call`, which resolves method and path from the shared route
 *    table of the contract (`INTERNAL_ROUTES` = `ALL_ROUTES` + `API_KEY_ROUTES` + `OPERATIONS_ROUTES`), so a method cannot target a route that does not exist;
 *  - `Authorization: Bearer <App Bridge session token>` (fresh token per request);
 *  - `Idempotency-Key` on every POST (14.1): callers that retry the SAME user action after a cut
 *    must pass the same `idempotencyKey` (15.5 "Envois sûrs");
 *  - errors are problem+json (RFC 9457) converted to `ApiError` with the stable `code`.
 *
 * `mock.ts` implements the same `ApiClient` interface with in-memory fixtures (VITE_API_MOCK=1).
 */
import {
  INTERNAL_BASE,
  INTERNAL_ROUTES,
  type InternalRouteName,
  type Anomaly,
  type ApiKey,
  type CreateApiKeyRequest,
  type CreateApiKeyResponse,
  type AutomationStateResponse,
  type CheckUnitsBatchResponse,
  type CreateImportRequest,
  type CreateUnitsBatchRequest,
  type CreateUnitsBatchResponse,
  type ErrorCode,
  type HealthResponse,
  type HomeStatsResponse,
  type ImportReport,
  type ImportReportExtras,
  type ListLocationsResponse,
  type ListTrackedItemsQuery,
  type ListUnitsQuery,
  type LookupResponse,
  type MeResponse,
  type MeResponseAdminExtras,
  type Page,
  type PatchSettingsRequest,
  type Problem,
  type ResolveAnomalyRequest,
  type SettingScope,
  type SettingsResponse,
  type SettingsSimulation,
  type SimulateSettingsRequest,
  type TrackedItem,
  type TrackItemsRequest,
  type TrackItemsResponse,
  type Unit,
  type UnitEvent,
  type AnomalySeverity,
} from '@serialis/contract';
import { getSessionToken } from '../shopify';

export type Me = MeResponse & MeResponseAdminExtras;
export type ImportReportFull = ImportReport & ImportReportExtras;

export interface PageParams {
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface ListAnomaliesQuery extends PageParams {
  status?: Anomaly['status'] | undefined;
  severity?: AnomalySeverity | undefined;
  type?: string | undefined;
}

/** Options of the POST calls. */
export interface WriteOptions {
  /** Reuse the key of a previous attempt of the same user action; a new one is generated otherwise. */
  idempotencyKey?: string | undefined;
}

export interface ApiClient {
  me(): Promise<Me>;
  homeStats(): Promise<HomeStatsResponse>;

  listTrackedItems(query?: ListTrackedItemsQuery): Promise<Page<TrackedItem>>;
  trackItems(req: TrackItemsRequest, opts?: WriteOptions): Promise<TrackItemsResponse>;

  listUnits(query?: ListUnitsQuery): Promise<Page<Unit>>;
  getUnit(id: string): Promise<Unit>;
  unitEvents(id: string, params?: PageParams): Promise<Page<UnitEvent>>;
  lookup(identifier: string): Promise<LookupResponse>;
  checkUnitsBatch(req: CreateUnitsBatchRequest, opts?: WriteOptions): Promise<CheckUnitsBatchResponse>;
  createUnitsBatch(req: CreateUnitsBatchRequest, opts?: WriteOptions): Promise<CreateUnitsBatchResponse>;

  listAnomalies(query?: ListAnomaliesQuery): Promise<Page<Anomaly>>;
  acknowledgeAnomaly(id: string, opts?: WriteOptions): Promise<Anomaly>;
  resolveAnomaly(id: string, req: ResolveAnomalyRequest, opts?: WriteOptions): Promise<Anomaly>;

  listLocations(): Promise<ListLocationsResponse>;

  getSettings(scope: SettingScope): Promise<SettingsResponse>;
  simulateSettings(req: SimulateSettingsRequest, opts?: WriteOptions): Promise<SettingsSimulation>;
  patchSettings(req: PatchSettingsRequest): Promise<SettingsResponse>;

  createImport(req: CreateImportRequest, opts?: WriteOptions): Promise<ImportReportFull>;
  confirmImport(id: string, opts?: WriteOptions): Promise<ImportReportFull>;

  pause(opts?: WriteOptions): Promise<AutomationStateResponse>;
  resume(opts?: WriteOptions): Promise<AutomationStateResponse>;

  /** API keys (15.4 "Réglages › API", administrators): the full key is only in the creation response. */
  listApiKeys(): Promise<Page<ApiKey>>;
  createApiKey(req: CreateApiKeyRequest): Promise<CreateApiKeyResponse>;
  revokeApiKey(prefix: string): Promise<void>;

  /** Health of the shop (17.1, 17.2), administrators only: state, counters, passes, dead tasks and writes. */
  health(): Promise<HealthResponse>;
}

/** Contract route used by each client method (checked by `client.contract.test.ts`). */
export const CLIENT_ROUTES = {
  me: 'me',
  homeStats: 'homeStats',
  listTrackedItems: 'listTrackedItems',
  trackItems: 'trackItems',
  listUnits: 'listUnits',
  getUnit: 'getUnit',
  unitEvents: 'unitEvents',
  lookup: 'lookup',
  checkUnitsBatch: 'checkUnitsBatch',
  createUnitsBatch: 'createUnitsBatch',
  listAnomalies: 'listAnomalies',
  acknowledgeAnomaly: 'acknowledgeAnomaly',
  resolveAnomaly: 'resolveAnomaly',
  listLocations: 'listLocations',
  getSettings: 'getSettings',
  simulateSettings: 'simulateSettings',
  patchSettings: 'patchSettings',
  createImport: 'createImport',
  confirmImport: 'confirmImport',
  pause: 'pause',
  resume: 'resume',
  listApiKeys: 'listApiKeys',
  createApiKey: 'createApiKey',
  revokeApiKey: 'revokeApiKey',
  health: 'health',
} as const satisfies Record<keyof ApiClient, InternalRouteName>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ClientErrorCode = ErrorCode | 'network' | 'unknown';

/** Error raised by every client; `code` is the stable code of the problem+json (spec 14.1). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly detail: string | undefined;
  readonly errors: Problem['errors'];
  readonly retryAfterSeconds: number | undefined;

  constructor(init: {
    status: number;
    code: ClientErrorCode;
    title?: string;
    detail?: string | undefined;
    errors?: Problem['errors'];
    retryAfterSeconds?: number | undefined;
  }) {
    super(init.detail ?? init.title ?? init.code);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.detail = init.detail;
    this.errors = init.errors;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

const STATUS_CODES: Record<number, ErrorCode> = {
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'idempotency_conflict',
  412: 'precondition_failed',
  422: 'validation_failed',
  429: 'rate_limited',
};

export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// HTTP implementation
// ---------------------------------------------------------------------------

export interface HttpClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  getToken?: () => Promise<string>;
}

interface CallInit {
  pathParams?: Record<string, string>;
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  idempotencyKey?: string | undefined;
}

function splitRoute(route: string): { method: string; template: string } {
  const [method, template] = route.split(' ');
  if (!method || !template) throw new Error(`Malformed route "${route}"`);
  return { method, template };
}

export class HttpClient implements ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getToken: () => Promise<string>;

  constructor(options: HttpClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? INTERNAL_BASE;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.getToken = options.getToken ?? getSessionToken;
  }

  private async call<T>(name: InternalRouteName, init: CallInit = {}): Promise<T> {
    const { method, template } = splitRoute(INTERNAL_ROUTES[name]);
    const path = template.replace(/\{(\w+)\}/g, (_m, key: string) => {
      const value = init.pathParams?.[key];
      if (value === undefined) throw new Error(`Missing path parameter "${key}" for ${name}`);
      return encodeURIComponent(value);
    });
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v === undefined || v === '') continue;
      search.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    const qs = search.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const idempotencyKey = method === 'POST' ? (init.idempotencyKey ?? newIdempotencyKey()) : undefined;

    for (let attempt = 0; ; attempt++) {
      let token: string;
      try {
        token = await this.getToken();
      } catch {
        throw new ApiError({ status: 401, code: 'unauthenticated', detail: 'No session token available.' });
      }
      const headers: Record<string, string> = { Accept: 'application/json, application/problem+json', Authorization: `Bearer ${token}` };
      if (init.body !== undefined) headers['Content-Type'] = 'application/json';
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
      } catch {
        throw new ApiError({ status: 0, code: 'network', detail: 'The server could not be reached.' });
      }

      // Expired session token: Shopify asks for exactly one retry with a fresh token.
      if (response.status === 401 && attempt === 0 && response.headers.get('X-Shopify-Retry-Invalid-Session-Request') === '1') {
        continue;
      }
      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }
      throw await toApiError(response);
    }
  }

  me() {
    return this.call<Me>('me');
  }
  homeStats() {
    return this.call<HomeStatsResponse>('homeStats');
  }
  listTrackedItems(query: ListTrackedItemsQuery = {}) {
    return this.call<Page<TrackedItem>>('listTrackedItems', { query: { variant: query.variant, product: query.product, cursor: query.cursor, limit: query.limit } });
  }
  trackItems(req: TrackItemsRequest, opts: WriteOptions = {}) {
    return this.call<TrackItemsResponse>('trackItems', { body: req, idempotencyKey: opts.idempotencyKey });
  }
  listUnits(query: ListUnitsQuery = {}) {
    return this.call<Page<Unit>>('listUnits', {
      query: {
        variant: query.variant,
        location: query.location,
        state: query.state === undefined ? undefined : Array.isArray(query.state) ? query.state : [query.state],
        q: query.q,
        cursor: query.cursor,
        limit: query.limit,
      },
    });
  }
  getUnit(id: string) {
    return this.call<Unit>('getUnit', { pathParams: { id } });
  }
  unitEvents(id: string, params: PageParams = {}) {
    return this.call<Page<UnitEvent>>('unitEvents', { pathParams: { id }, query: { cursor: params.cursor, limit: params.limit } });
  }
  lookup(identifier: string) {
    return this.call<LookupResponse>('lookup', { query: { identifier } });
  }
  checkUnitsBatch(req: CreateUnitsBatchRequest, opts: WriteOptions = {}) {
    return this.call<CheckUnitsBatchResponse>('checkUnitsBatch', { body: req, idempotencyKey: opts.idempotencyKey });
  }
  createUnitsBatch(req: CreateUnitsBatchRequest, opts: WriteOptions = {}) {
    return this.call<CreateUnitsBatchResponse>('createUnitsBatch', { body: req, idempotencyKey: opts.idempotencyKey });
  }
  listAnomalies(query: ListAnomaliesQuery = {}) {
    return this.call<Page<Anomaly>>('listAnomalies', {
      query: { status: query.status, severity: query.severity, type: query.type, cursor: query.cursor, limit: query.limit },
    });
  }
  acknowledgeAnomaly(id: string, opts: WriteOptions = {}) {
    return this.call<Anomaly>('acknowledgeAnomaly', { pathParams: { id }, idempotencyKey: opts.idempotencyKey });
  }
  resolveAnomaly(id: string, req: ResolveAnomalyRequest, opts: WriteOptions = {}) {
    return this.call<Anomaly>('resolveAnomaly', { pathParams: { id }, body: req, idempotencyKey: opts.idempotencyKey });
  }
  listLocations() {
    return this.call<ListLocationsResponse>('listLocations');
  }
  getSettings(scope: SettingScope) {
    return this.call<SettingsResponse>('getSettings', { query: { scope } });
  }
  simulateSettings(req: SimulateSettingsRequest, opts: WriteOptions = {}) {
    return this.call<SettingsSimulation>('simulateSettings', { body: req, idempotencyKey: opts.idempotencyKey });
  }
  patchSettings(req: PatchSettingsRequest) {
    return this.call<SettingsResponse>('patchSettings', { body: req });
  }
  createImport(req: CreateImportRequest, opts: WriteOptions = {}) {
    return this.call<ImportReportFull>('createImport', { body: req, idempotencyKey: opts.idempotencyKey });
  }
  confirmImport(id: string, opts: WriteOptions = {}) {
    return this.call<ImportReportFull>('confirmImport', { pathParams: { id }, idempotencyKey: opts.idempotencyKey });
  }
  pause(opts: WriteOptions = {}) {
    return this.call<AutomationStateResponse>('pause', { idempotencyKey: opts.idempotencyKey });
  }
  resume(opts: WriteOptions = {}) {
    return this.call<AutomationStateResponse>('resume', { idempotencyKey: opts.idempotencyKey });
  }
  listApiKeys() {
    return this.call<Page<ApiKey>>('listApiKeys');
  }
  /** Not replayed by the server (the response carries the secret): a retry creates another key. */
  createApiKey(req: CreateApiKeyRequest) {
    return this.call<CreateApiKeyResponse>('createApiKey', { body: req });
  }
  revokeApiKey(prefix: string) {
    return this.call<void>('revokeApiKey', { pathParams: { prefix } });
  }
  health() {
    return this.call<HealthResponse>('health');
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const retryAfter = Number(response.headers.get('Retry-After'));
  const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
  let problem: Partial<Problem> | undefined;
  try {
    const text = await response.text();
    if (text) problem = JSON.parse(text) as Partial<Problem>;
  } catch {
    problem = undefined;
  }
  const code: ClientErrorCode = problem?.code ?? STATUS_CODES[response.status] ?? 'unknown';
  return new ApiError({
    status: response.status,
    code,
    ...(problem?.title !== undefined ? { title: problem.title } : {}),
    detail: problem?.detail,
    errors: problem?.errors,
    retryAfterSeconds,
  });
}
