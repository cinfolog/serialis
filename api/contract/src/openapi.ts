/**
 * OpenAPI 3.1 description of the public API (spec 14.1: "spécification OpenAPI 3.1 publiée et
 * testée"), generated from the contract: one operation per entry of `PUBLIC_ROUTES`, with the scope
 * it requires. Served by the Worker at `GET /v1/openapi.json` (api host) or
 * `GET /public/v1/openapi.json` (staging, pilot); the Worker contract test checks that every
 * operation here is routed by the Worker and the reverse.
 */
import { API_SCOPES, ERROR_CODES as CONTRACT_ERROR_CODES, PUBLIC_ROUTES, type PublicRouteName } from './index.js';

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const str = (extra: Schema = {}): Schema => ({ type: 'string', ...extra });
const nullable = (s: Schema): Schema => ({ oneOf: [s, { type: 'null' }] });
const dateTime = str({ format: 'date-time' });
const obj = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema => ({ type: 'object', properties, required });
const pageOf = (item: string): Schema => obj({ items: { type: 'array', items: ref(item) }, nextCursor: nullable(str()) });

const UNIT_STATES = ['INCOMING', 'AVAILABLE', 'HELD', 'ALLOCATED', 'QUALITY_CONTROL', 'DAMAGED', 'IN_TRANSIT', 'SHIPPED', 'RETURN_PENDING', 'TO_VERIFY', 'LOST', 'SCRAPPED', 'UNTRACKED'];
const ERROR_CODES = [...CONTRACT_ERROR_CODES];

const schemas: Record<string, Schema> = {
  Problem: {
    ...obj(
      {
        type: str(),
        title: str(),
        status: { type: 'integer' },
        code: str({ enum: ERROR_CODES }),
        detail: str(),
        errors: { type: 'array', items: obj({ index: { type: 'integer' }, field: str(), code: str({ enum: ERROR_CODES }), detail: str() }, ['code']) },
      },
      ['type', 'title', 'status', 'code'],
    ),
  },
  Identifier: obj({ id: str(), type: str(), value: str(), primary: { type: 'boolean' } }),
  Unit: obj({
    id: str(),
    variantGid: str(),
    locationId: nullable(str()),
    state: str({ enum: UNIT_STATES }),
    identifiers: { type: 'array', items: ref('Identifier') },
    ref: str(),
    receivedAt: nullable(dateTime),
    orderGid: nullable(str()),
    version: { type: 'integer' },
    createdAt: dateTime,
    updatedAt: dateTime,
  }),
  UnitPage: pageOf('Unit'),
  CreateUnitRequest: obj({ variantGid: str(), locationId: str(), ref: str(), alreadyCounted: { type: 'boolean' } }, ['variantGid', 'locationId', 'ref']),
  CreateUnitsBatchRequest: obj(
    { variantGid: str(), locationId: str(), refs: { type: 'array', items: str(), minItems: 1, maxItems: 1000 }, alreadyCounted: { type: 'boolean' }, mode: str({ enum: ['atomic', 'per_item'] }) },
    ['variantGid', 'locationId', 'refs', 'alreadyCounted'],
  ),
  CreateUnitsBatchResponse: obj({
    created: { type: 'array', items: ref('Unit') },
    rejected: { type: 'array', items: obj({ index: { type: 'integer' }, ref: str(), code: str({ enum: ERROR_CODES }), detail: str() }, ['index', 'ref', 'code']) },
  }),
  CheckUnitsBatchResponse: obj({
    rows: { type: 'array', items: obj({ index: { type: 'integer' }, ref: str(), status: str({ enum: ['ready', 'duplicate_in_list', 'already_known', 'invalid_format', 'beyond_gap'] }), detail: str() }, ['index', 'ref', 'status']) },
    ready: { type: 'integer' },
    stockWrite: { type: 'integer' },
    gapBefore: nullable({ type: 'integer' }),
  }),
  LookupResponse: obj({ unit: nullable(ref('Unit')) }),
  UnitEvent: obj({
    id: str(), at: dateTime, actor: str(), type: str(),
    fromState: nullable(str({ enum: UNIT_STATES })), toState: nullable(str({ enum: UNIT_STATES })),
    reason: nullable(str()), stockEffect: nullable(str()), stockDelta: nullable({ type: 'integer' }), stockQuantity: nullable(str()),
  }, ['id', 'at', 'actor', 'type', 'fromState', 'toState', 'reason', 'stockEffect']),
  UnitEventPage: pageOf('UnitEvent'),
  TrackedItem: obj({
    variantGid: str(), productGid: str(), title: str(), variantTitle: nullable(str()), sku: nullable(str()), mode: str({ enum: ['interchangeable'] }),
    initializing: { type: 'boolean' }, activatedAt: dateTime,
    stock: { type: 'array', items: obj({ locationId: str(), shopifyOnHand: { type: 'integer' }, registeredUnits: { type: 'integer' }, availableUnits: { type: 'integer' } }) },
  }),
  TrackedItemPage: pageOf('TrackedItem'),
  TrackItemsRequest: obj({ action: str({ enum: ['track', 'untrack'] }), variantGids: { type: 'array', items: str() }, applyToOpenOrders: { type: 'boolean' } }, ['variantGids']),
  Allocation: obj({
    id: str(), unitId: str(), ref: str(), orderGid: str(), lineItemGid: str(), variantGid: str(), locationId: str(),
    status: str({ enum: ['active', 'fulfilled', 'released', 'returned'] }),
    source: str({ enum: ['auto', 'pick', 'pos', 'draft', 'api', 'late', 'migration'] }),
    toConfirm: { type: 'boolean' }, allocatedAt: dateTime, unitState: str({ enum: UNIT_STATES }),
  }),
  OrderAllocationsResponse: obj({
    orderGid: str(),
    lines: { type: 'array', items: obj({ lineItemGid: str(), variantGid: str(), title: str(), tracked: { type: 'boolean' }, quantity: { type: 'integer' }, orderedQuantity: { type: 'integer' }, allocations: { type: 'array', items: ref('Allocation') }, missing: { type: 'integer' } }) },
    syncState: str({ enum: ['pending', 'synced', 'error'] }),
    syncedAt: nullable(dateTime),
    automationPaused: { type: 'boolean' },
  }, ['orderGid', 'lines', 'syncState', 'syncedAt']),
  CreateAllocationRequest: obj({ orderGid: str(), lineItemGid: str(), unitId: str(), ref: str() }, ['orderGid', 'lineItemGid']),
  ReplaceAllocationRequest: obj({ unitId: str(), ref: str() }, []),
  ConfirmShippedRequest: obj({ ref: str() }),
  IdentifyReturnRequest: obj({ returnLineItemGid: str(), ref: str() }),
  Anomaly: obj({
    id: str(), type: str(), severity: str({ enum: ['critical', 'warning', 'info'] }), status: str({ enum: ['open', 'acknowledged', 'resolved'] }),
    orderGid: nullable(str()), variantGid: nullable(str()), unitId: nullable(str()), locationId: nullable(str()), summary: str(),
    actions: { type: 'array', items: obj({ action: str(), label: str(), writesStock: { type: 'boolean' }, needsRef: { type: 'boolean' } }) },
    openedAt: dateTime, resolvedAt: nullable(dateTime), remaining: { type: 'integer', minimum: 0 },
  }),
  AnomalyPage: pageOf('Anomaly'),
  ResolveAnomalyRequest: obj({ action: str(), params: { type: 'object', additionalProperties: true } }, ['action']),
  Location: obj({ id: str(), name: str(), active: { type: 'boolean' } }),
  LocationPage: pageOf('Location'),
  SettingValue: obj({
    key: str(), value: { type: ['string', 'number', 'boolean'] },
    origin: str({ enum: ['default', 'shop', 'location', 'tracked_item', 'fixed'] }), changeRule: str({ enum: ['immediate', 'simulation'] }),
  }),
  SettingsResponse: obj({ scope: str(), values: { type: 'array', items: ref('SettingValue') } }),
  SimulateSettingsRequest: obj({ scope: str(), values: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } } }),
  PatchSettingsRequest: obj({ scope: str(), values: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } }, simulationId: str() }, ['scope', 'values']),
  SettingsSimulation: obj({
    simulationId: str(), expiresAt: dateTime,
    effects: { type: 'array', items: obj({ key: str(), count: { type: 'integer' }, summary: str() }) },
    warnings: { type: 'array', items: str() },
  }),
  CreateImportRequest: obj({ filename: str(), csv: str() }, ['csv']),
  ImportReport: obj(
    {
      id: str(), status: str({ enum: ['simulated', 'confirmed', 'failed'] }), rows: { type: 'integer' }, valid: { type: 'integer' },
      errors: { type: 'array', items: obj({ row: { type: 'integer' }, code: str({ enum: ERROR_CODES }), detail: str() }) },
      beyondGap: { type: 'integer' }, stockWrites: { type: 'integer' },
    },
    ['id', 'status', 'rows', 'valid', 'errors'],
  ),
  AutomationStateResponse: obj({ emergencyStop: { type: 'boolean' } }),
};

interface OperationSpec {
  summary: string;
  request?: string;
  response: { status: number; schema?: string };
  query?: Array<{ name: string; description: string; required?: boolean }>;
  ifMatch?: boolean;
}

const PAGE_QUERY = [
  { name: 'cursor', description: 'Opaque cursor returned as `nextCursor` by the previous page.' },
  { name: 'limit', description: 'Page size, 1 to 250 (default 50).' },
];

const OPERATIONS: Record<PublicRouteName, OperationSpec> = {
  listTrackedItems: { summary: 'List tracked items', response: { status: 200, schema: 'TrackedItemPage' }, query: [{ name: 'variant', description: 'Variant GID' }, { name: 'product', description: 'Product GID' }, ...PAGE_QUERY] },
  trackItems: { summary: 'Activate (or deactivate with `action: "untrack"`) the tracking of variants', request: 'TrackItemsRequest', response: { status: 200, schema: 'TrackedItemPage' } },
  listUnits: {
    summary: 'List units',
    response: { status: 200, schema: 'UnitPage' },
    query: [
      { name: 'variant', description: 'Variant GID' },
      { name: 'location', description: 'Location GID' },
      { name: 'state', description: 'One or more states, repeated or comma separated' },
      { name: 'q', description: 'Identifier search (normalized)' },
      ...PAGE_QUERY,
    ],
  },
  createUnit: { summary: 'Create one unit (same rules as the atomic batch)', request: 'CreateUnitRequest', response: { status: 201, schema: 'Unit' } },
  getUnit: { summary: 'Read a unit (ETag from its version)', response: { status: 200, schema: 'Unit' } },
  createUnitsBatch: { summary: 'Create up to 1,000 units of one variant at one location (atomic or per item)', request: 'CreateUnitsBatchRequest', response: { status: 201, schema: 'CreateUnitsBatchResponse' } },
  checkUnitsBatch: { summary: 'Check a batch without writing anything', request: 'CreateUnitsBatchRequest', response: { status: 200, schema: 'CheckUnitsBatchResponse' } },
  lookup: { summary: 'Find a unit by any identifier', response: { status: 200, schema: 'LookupResponse' }, query: [{ name: 'identifier', description: 'Identifier value', required: true }] },
  unitEvents: { summary: 'History of a unit', response: { status: 200, schema: 'UnitEventPage' }, query: PAGE_QUERY },
  orderAllocations: { summary: 'Units of an order, line by line', response: { status: 200, schema: 'OrderAllocationsResponse' } },
  createAllocation: { summary: 'Allocate a unit to an order line', request: 'CreateAllocationRequest', response: { status: 201, schema: 'Allocation' } },
  deleteAllocation: { summary: 'Remove an allocated unit before shipping', response: { status: 204 }, ifMatch: true },
  replaceAllocation: { summary: 'Replace an allocated unit', request: 'ReplaceAllocationRequest', response: { status: 201, schema: 'Allocation' }, ifMatch: true },
  confirmShipped: { summary: 'Designate the unit really shipped', request: 'ConfirmShippedRequest', response: { status: 200, schema: 'Allocation' }, ifMatch: true },
  identifyReturn: { summary: 'Identify the unit received in a return', request: 'IdentifyReturnRequest', response: { status: 202 } },
  listAnomalies: { summary: 'List anomalies', response: { status: 200, schema: 'AnomalyPage' }, query: [{ name: 'status', description: 'open, acknowledged or resolved' }, { name: 'severity', description: 'critical, warning or info' }, { name: 'type', description: 'Anomaly type (12.7)' }, ...PAGE_QUERY] },
  acknowledgeAnomaly: { summary: 'Acknowledge an anomaly', response: { status: 200, schema: 'Anomaly' } },
  resolveAnomaly: { summary: 'Resolve an anomaly (a resolution that writes the Shopify stock requires the `admin` scope)', request: 'ResolveAnomalyRequest', response: { status: 200, schema: 'Anomaly' } },
  listLocations: { summary: 'Locations known to the app', response: { status: 200, schema: 'LocationPage' } },
  getSettings: { summary: 'Settings of a scope with their origin', response: { status: 200, schema: 'SettingsResponse' }, query: [{ name: 'scope', description: '`shop`, `location:<id>` or `tracked_item:<id>`' }] },
  simulateSettings: { summary: 'Simulate a change of "simulation" settings (id valid 10 minutes)', request: 'SimulateSettingsRequest', response: { status: 200, schema: 'SettingsSimulation' } },
  patchSettings: { summary: 'Change settings', request: 'PatchSettingsRequest', response: { status: 200, schema: 'SettingsResponse' }, ifMatch: true },
  createImport: { summary: 'Simulate a CSV import', request: 'CreateImportRequest', response: { status: 201, schema: 'ImportReport' } },
  getImport: { summary: 'Import report', response: { status: 200, schema: 'ImportReport' } },
  confirmImport: { summary: 'Confirm a simulated import', response: { status: 200, schema: 'ImportReport' } },
  pause: { summary: 'Emergency stop: suspend automatic allocation', response: { status: 200, schema: 'AutomationStateResponse' } },
  resume: { summary: 'Resume automatic allocation', response: { status: 200, schema: 'AutomationStateResponse' } },
};

const problemResponse = (description: string, headers?: Record<string, unknown>) => ({
  description,
  ...(headers ? { headers } : {}),
  content: { 'application/problem+json': { schema: ref('Problem') } },
});

const RATE_HEADERS = {
  'RateLimit-Limit': { schema: { type: 'integer' }, description: 'Burst size of the key (100).' },
  'RateLimit-Remaining': { schema: { type: 'integer' }, description: 'Requests left in the bucket.' },
  'RateLimit-Reset': { schema: { type: 'integer' }, description: 'Seconds until the bucket is full again.' },
};

function operation(name: PublicRouteName, method: string, path: string, scope: string): Schema {
  const spec = OPERATIONS[name];
  const parameters: Schema[] = [];
  for (const m of path.matchAll(/\{(\w+)\}/g)) parameters.push({ name: m[1], in: 'path', required: true, schema: str() });
  for (const q of spec.query ?? []) parameters.push({ name: q.name, in: 'query', required: q.required ?? false, description: q.description, schema: str() });
  if (method === 'POST') parameters.push({ $ref: '#/components/parameters/IdempotencyKey' });
  if (spec.ifMatch) parameters.push({ $ref: '#/components/parameters/IfMatch' });
  const success: Schema = { description: spec.summary, headers: RATE_HEADERS };
  if (spec.response.schema) success.content = { 'application/json': { schema: ref(spec.response.schema) } };
  return {
    operationId: name,
    summary: spec.summary,
    'x-required-scope': scope,
    security: [{ apiKey: [scope] }],
    ...(parameters.length ? { parameters } : {}),
    ...(spec.request ? { requestBody: { required: true, content: { 'application/json': { schema: ref(spec.request) } } } } : {}),
    responses: {
      [String(spec.response.status)]: success,
      '400': { $ref: '#/components/responses/Problem' },
      '401': { $ref: '#/components/responses/Unauthenticated' },
      '403': { $ref: '#/components/responses/Problem' },
      '404': { $ref: '#/components/responses/Problem' },
      ...(method === 'POST' ? { '409': { $ref: '#/components/responses/Problem' } } : {}),
      ...(spec.ifMatch ? { '412': { $ref: '#/components/responses/Problem' } } : {}),
      '422': { $ref: '#/components/responses/Problem' },
      '429': { $ref: '#/components/responses/RateLimited' },
    },
  };
}

function buildPaths(): Record<string, Record<string, Schema>> {
  const paths: Record<string, Record<string, Schema>> = {};
  for (const [name, def] of Object.entries(PUBLIC_ROUTES) as Array<[PublicRouteName, { route: string; scope: string }]>) {
    const [method, path] = def.route.split(' ') as [string, string];
    (paths[path] ??= {})[method.toLowerCase()] = operation(name, method, path, def.scope);
  }
  return paths;
}

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Serialis public API',
    version: '1.0.0',
    description:
      'Serialized inventory for Shopify (spec 14). Authentication: `Authorization: Bearer srl_…` API key created in the app (Settings › API keys), with scopes. ' +
      '`Idempotency-Key` is required on every POST (replayed 24 h, 409 when the body differs); `If-Match` with the ETag on the routes that change a versioned resource (412 when stale); ' +
      'cursor pagination (`limit` ≤ 250); errors as problem+json (RFC 9457) with a stable `code`; 20 requests per second per key with a burst of 100 (`RateLimit-*` headers, 429 with `Retry-After`). ' +
      'Additive changes without notice; an incompatible change is a new major version, the previous one kept 12 months.',
  },
  servers: [{ url: 'https://api.serialis.dev/v1' }],
  security: [{ apiKey: [] }],
  paths: buildPaths(),
  components: {
    securitySchemes: {
      apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'srl_<version>_<location>_<shop>_<prefix>_<seal>.<secret>', description: `Scopes: ${API_SCOPES.join(', ')}.` },
    },
    parameters: {
      IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: true, description: '1 to 255 characters; the response is replayed for 24 h.', schema: str({ minLength: 1, maxLength: 255 }) },
      IfMatch: { name: 'If-Match', in: 'header', required: false, description: 'ETag of the resource read before the change.', schema: str() },
    },
    responses: {
      Problem: problemResponse('Error (problem+json)'),
      Unauthenticated: problemResponse('Missing, malformed, unknown or revoked API key', { 'WWW-Authenticate': { schema: str() } }),
      RateLimited: problemResponse('Too many requests', { 'Retry-After': { schema: { type: 'integer' } }, ...RATE_HEADERS }),
    },
    schemas,
  },
} as const;
