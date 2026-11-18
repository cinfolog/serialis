import type { DocumentNode, FieldNode, FragmentDefinitionNode, OperationDefinitionNode, SelectionSetNode } from 'graphql';
import { GraphQLError, Kind, parse, valueFromASTUntyped } from 'graphql';
import { queryRoot } from './builders.js';
import type { Ctx, GqlError } from './engine.js';
import { AccessDenied, SimAbort, SimFieldError, argsOf, project, staticCost } from './engine.js';
import { FaultInjector } from './faults.js';
import type { Fault } from './faults.js';
import { Merchant } from './merchant.js';
import type { MerchantOptions } from './merchant.js';
import type { BulkOperation, StoredQuantityName } from './model.js';
import { IDEMPOTENT_REQUIRED, MUTATIONS, STOCK_MUTATIONS, userErrorResult } from './mutations.js';
import type { MutationEnv, MutationResult } from './mutations.js';
import { OAuthServer } from './oauth.js';
import type { OAuthOptions } from './oauth.js';
import { Shop } from './shop.js';
import type { SeedVariant, ShopOptions } from './shop.js';
import { Clock, mulberry32, stableStringify } from './util.js';
import { DEFAULT_WEBHOOK_SECRET, WebhookDelivery } from './webhooks.js';

type Obj = Record<string, unknown>;

export interface BucketOptions {
  /** Default 1000 (Standard plan: 1000 points, restore 100/s). */
  maximumAvailable?: number;
  currentlyAvailable?: number;
  restoreRate?: number;
}

export interface SimOptions extends ShopOptions {
  /** HMAC secret for webhooks (default `sim-webhook-secret`). */
  webhookSecret?: string;
  /** Seed of the deterministic RNG used for tokens (default 1). */
  seed?: number;
  bucket?: BucketOptions;
  /** Single query cost ceiling (default 1000). */
  maxQueryCost?: number;
  /** Check `X-Shopify-Access-Token` against tokens issued by the fake OAuth endpoint (default false). */
  enforceAuth?: boolean;
  /** Reject stock mutations that lack `@idempotent` (default true, spec 12.4). */
  requireIdempotency?: boolean;
  /** Replaying a key whose first attempt failed with userErrors: `previous_attempt_failed` (default) or the same result. */
  replayFailed?: 'previous_attempt_failed' | 'same_result';
  /** Idempotency key retention (default 24 h). */
  idempotencyTtlMs?: number;
  /** Simultaneous bulk operations allowed (default 5). */
  maxBulkOperations?: number;
  merchant?: MerchantOptions;
  oauth?: OAuthOptions;
}

export interface RequestLogEntry {
  at: string;
  kind: 'graphql' | 'oauth' | 'other';
  /** Root fields (GraphQL) or `oauth`. */
  operations: string[];
  mutation: boolean;
  status: number;
  /** Fault kind that fired, if any. */
  fault?: string;
  idempotencyKey?: string;
  replay?: boolean;
  requestedCost?: number;
  actualCost?: number;
  /** `extensions.code` of top-level errors. */
  errorCodes: string[];
  /** `code` of userErrors in the payloads. */
  userErrorCodes: string[];
}

interface IdemRecord {
  fingerprint: string;
  body: Obj;
  failed: boolean;
  at: number;
}

const DOC = 'https://shopify.dev/api/usage/rate-limits';

/** In-memory fake of one Shopify shop and of the Admin GraphQL API in front of it. */
export class ShopifySim {
  readonly shop: Shop;
  readonly clock: Clock;
  readonly merchant: Merchant;
  readonly faults = new FaultInjector();
  readonly oauth: OAuthServer;
  readonly webhooks: WebhookDelivery;
  readonly webhookSecret: string;
  /** Every request received, in order. */
  readonly requests: RequestLogEntry[] = [];
  /** Contract breaches by the app under test (null `changeFromQuantity`, missing `@idempotent`, ...). Should stay empty. */
  readonly violations: string[] = [];
  readonly options: Required<Pick<SimOptions, 'maxQueryCost' | 'enforceAuth' | 'requireIdempotency' | 'replayFailed' | 'idempotencyTtlMs' | 'maxBulkOperations'>>;

  private readonly bucket: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number; at: number };
  private readonly idem = new Map<string, IdemRecord>();
  private readonly bulkFiles = new Map<string, string>();

  constructor(opts: SimOptions = {}) {
    this.clock = opts.clock ?? new Clock();
    this.shop = new Shop({ ...opts, clock: this.clock });
    this.merchant = new Merchant(this.shop, opts.merchant);
    this.webhookSecret = opts.webhookSecret ?? DEFAULT_WEBHOOK_SECRET;
    this.webhooks = new WebhookDelivery(this.shop.events, this.clock, { secret: this.webhookSecret });
    const rng = mulberry32(opts.seed ?? 1);
    this.oauth = new OAuthServer(() => this.clock.now(), rng, () => this.shop.scopes, opts.oauth);
    const max = opts.bucket?.maximumAvailable ?? 1000;
    this.bucket = { maximumAvailable: max, currentlyAvailable: opts.bucket?.currentlyAvailable ?? max, restoreRate: opts.bucket?.restoreRate ?? 100, at: this.clock.now() };
    this.options = {
      maxQueryCost: opts.maxQueryCost ?? 1000,
      enforceAuth: opts.enforceAuth ?? false,
      requireIdempotency: opts.requireIdempotency ?? true,
      replayFailed: opts.replayFailed ?? 'previous_attempt_failed',
      idempotencyTtlMs: opts.idempotencyTtlMs ?? 24 * 3600 * 1000,
      maxBulkOperations: opts.maxBulkOperations ?? 5,
    };
  }

  // ---- seeding shortcuts -----------------------------------------------------------------

  addLocation(name: string, opts?: { active?: boolean }): string {
    return this.shop.addLocation(name, opts).id;
  }

  /** Creates a product with variants and returns their ids. */
  addProduct(title: string, variants?: SeedVariant[]): { productId: string; variantIds: string[]; itemIds: string[] } {
    const r = this.shop.addProduct(title, variants);
    return { productId: r.product.id, variantIds: r.variants.map((v) => v.id), itemIds: r.items.map((i) => i.id) };
  }

  /** Current bucket state (after refilling for the elapsed sim time). */
  throttleStatus(): { maximumAvailable: number; currentlyAvailable: number; restoreRate: number } {
    this.refill();
    const { maximumAvailable, currentlyAvailable, restoreRate } = this.bucket;
    return { maximumAvailable, currentlyAvailable, restoreRate };
  }

  /** Empties (or sets) the bucket, to provoke `THROTTLED` without crafting a huge query. */
  setBucket(currentlyAvailable: number): void {
    this.refill();
    this.bucket.currentlyAvailable = currentlyAvailable;
  }

  /** Number of requests seen for a root field (or `oauth`, `*`). */
  callCount(operation: string): number {
    return this.faults.callCount(operation);
  }

  /** Completes a running bulk operation with a JSONL result (default: inventory items followed by their levels) and emits `bulk_operations/finish`. */
  completeBulkOperation(id?: string, opts: { lines?: Obj[] } = {}): BulkOperation {
    const shop = this.shop;
    const op = id ? shop.bulkOperation(id) : [...shop.bulkOperations.values()].reverse().find((b) => b.status === 'RUNNING');
    if (!op) throw new Error('No running bulk operation');
    const lines: Obj[] = opts.lines ?? [];
    if (!opts.lines) {
      for (const item of shop.items.values()) {
        lines.push({ id: item.id, sku: item.sku, tracked: item.tracked });
        for (const lv of shop.levelsOfItem(item.id)) {
          lines.push({
            id: lv.id,
            __parentId: item.id,
            location: { id: lv.locationId },
            quantities: [...Object.entries(lv.q), ['on_hand', shop.quantity(lv, 'on_hand')]].map(([name, quantity]) => ({ name, quantity })),
          });
        }
      }
    }
    this.bulkFiles.set(op.id, lines.map((l) => JSON.stringify(l)).join('\n'));
    op.status = 'COMPLETED';
    op.completedAt = shop.stamp();
    op.objectCount = lines.length;
    op.url = `https://${shop.domain}/__sim/bulk/${op.id.split('/').pop()}.jsonl`;
    shop.emit('bulk_operations/finish', { admin_graphql_api_id: op.id, completed_at: op.completedAt, created_at: op.createdAt, error_code: null, status: 'completed', type: 'query' });
    return op;
  }

  // ---- fetch ---------------------------------------------------------------------------------

  /** `fetch`-compatible entry point: pass it wherever the app takes a `fetch`. */
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request && init === undefined ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname !== this.shop.domain) return new Response('Not Found', { status: 404 });
    if (req.method === 'POST' && url.pathname === '/admin/oauth/access_token') return this.handleOAuth(req);
    const m = /^\/admin\/api\/([^/]+)\/graphql\.json$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      if (m[1] !== this.shop.apiVersion) return json({ errors: 'Not Found' }, 404);
      return this.handleGraphql(req);
    }
    const bulk = /^\/__sim\/bulk\/(\d+)\.jsonl$/.exec(url.pathname);
    if (req.method === 'GET' && bulk) {
      const file = this.bulkFiles.get(`gid://shopify/BulkOperation/${bulk[1]}`);
      return file === undefined ? new Response('Not Found', { status: 404 }) : new Response(file, { headers: { 'Content-Type': 'application/jsonl' } });
    }
    return new Response('Not Found', { status: 404 });
  };

  private log(entry: Omit<RequestLogEntry, 'at'>): void {
    this.requests.push({ at: this.clock.iso(), ...entry });
  }

  private async handleOAuth(req: Request): Promise<Response> {
    const raw = await req.text();
    let params: Record<string, string> = {};
    if ((req.headers.get('content-type') ?? '').includes('json')) {
      try {
        params = Object.fromEntries(Object.entries(JSON.parse(raw) as Obj).map(([k, v]) => [k, String(v)]));
      } catch {
        return json({ error: 'invalid_request' }, 400);
      }
    } else params = Object.fromEntries(new URLSearchParams(raw));
    const hit = this.faults.observe(['oauth']);
    const fault = hit?.rule.fault;
    const base = { kind: 'oauth' as const, operations: ['oauth'], mutation: true, errorCodes: [], userErrorCodes: [] };
    if (fault?.kind === 'timeout' && !fault.applied) {
      this.log({ ...base, status: 0, fault: 'timeout' });
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }
    if (fault?.kind === 'http' && !fault.applied) {
      this.log({ ...base, status: fault.status, fault: 'http' });
      return new Response(fault.body ?? 'error', { status: fault.status });
    }
    const out = this.oauth.token(params);
    if (fault?.kind === 'timeout') {
      this.log({ ...base, status: 0, fault: 'timeout(applied)' });
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }
    if (fault?.kind === 'http') {
      this.log({ ...base, status: fault.status, fault: 'http(applied)' });
      return new Response(fault.body ?? 'error', { status: fault.status });
    }
    this.log({ ...base, status: out.status });
    return json(out.body, out.status);
  }

  private refill(): void {
    const now = this.clock.now();
    const b = this.bucket;
    b.currentlyAvailable = Math.min(b.maximumAvailable, b.currentlyAvailable + (b.restoreRate * (now - b.at)) / 1000);
    b.at = now;
  }

  private costExt(requested: number, actual: number | null, status = this.throttleStatus()): Obj {
    return { cost: { requestedQueryCost: requested, actualQueryCost: actual, throttleStatus: status } };
  }

  private async handleGraphql(req: Request): Promise<Response> {
    if (this.options.enforceAuth) {
      const state = this.oauth.check(req.headers.get('x-shopify-access-token'));
      if (state !== 'ok') {
        this.log({ kind: 'graphql', operations: [], mutation: false, status: 401, errorCodes: [], userErrorCodes: [] });
        return json({ errors: '[API] Invalid API key or access token (unrecognized login or wrong password)' }, 401);
      }
    }
    let body: { query?: unknown; variables?: unknown; operationName?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ errors: 'Bad request: invalid JSON' }, 400);
    }
    if (typeof body.query !== 'string') return json({ errors: [{ message: 'Query is required' }] }, 200);
    let doc: DocumentNode;
    try {
      doc = parse(body.query);
    } catch (e) {
      const ge = e as GraphQLError;
      return json({ errors: [{ message: ge.message, locations: ge.locations }] }, 200);
    }
    const fragments: Record<string, FragmentDefinitionNode> = {};
    const ops: OperationDefinitionNode[] = [];
    for (const d of doc.definitions) {
      if (d.kind === Kind.FRAGMENT_DEFINITION) fragments[d.name.value] = d;
      else if (d.kind === Kind.OPERATION_DEFINITION) ops.push(d);
    }
    const op = typeof body.operationName === 'string' ? ops.find((o) => o.name?.value === body.operationName) : ops.length === 1 ? ops[0] : undefined;
    if (!op) return json({ errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] }, 200);
    if (op.operation === 'subscription') return json({ errors: [{ message: 'Subscriptions are not supported.' }] }, 200);
    const isMutation = op.operation === 'mutation';

    // Variables (with defaults, required ones checked).
    const variables: Obj = { ...((body.variables as Obj | null | undefined) ?? {}) };
    for (const vd of op.variableDefinitions ?? []) {
      const name = vd.variable.name.value;
      if (variables[name] === undefined && vd.defaultValue) variables[name] = valueFromASTUntyped(vd.defaultValue);
      if (variables[name] === undefined && vd.type.kind === Kind.NON_NULL_TYPE) {
        return json({ errors: [{ message: `Variable $${name} of type ${printType(vd.type)} was provided invalid value`, extensions: { code: 'INVALID_VARIABLE' } }] }, 200);
      }
    }

    const rootFields = collectRootFields(op.selectionSet, fragments);
    const names = rootFields.map((f) => f.name.value);
    // Shopify places `@idempotent` on the mutation field (changelog 2025, 2026-04); the operation level is accepted too.
    const idemDirective =
      op.directives?.find((d) => d.name.value === 'idempotent') ??
      rootFields.flatMap((f) => f.directives ?? []).find((d) => d.name.value === 'idempotent');
    const idemKey = idemDirective ? String(valueFromASTUntyped(idemDirective.arguments?.find((a) => a.name.value === 'key')?.value ?? { kind: Kind.NULL }, variables) ?? '') : undefined;

    const ctx: Ctx = {
      shop: this.shop,
      scopes: new Set(this.shop.scopes),
      variables,
      fragments,
      errors: [],
      actualCost: 0,
      requireAny: (scopes) => {
        if (!scopes.some((s) => ctx.scopes.has(s))) throw new AccessDenied(scopes);
      },
    };
    const env: MutationEnv = { ctx, violations: this.violations, maxBulkOperations: this.options.maxBulkOperations };
    const logBase = { kind: 'graphql' as const, operations: names, mutation: isMutation, ...(idemKey ? { idempotencyKey: idemKey } : {}) };

    // Faults.
    const hit = this.faults.observe(names);
    const fault: Fault | undefined = hit?.rule.fault;
    this.refill();
    let requested: number;
    try {
      requested = staticCost(op.selectionSet, ctx) + (isMutation ? 10 * rootFields.length : 0);
    } catch (e) {
      if (e instanceof SimAbort) return json({ errors: e.errors }, 200);
      throw e;
    }

    const finish = (status: number, payload: Obj, extra: Partial<RequestLogEntry> = {}): Response => {
      const errors = (payload['errors'] as GqlError[] | undefined) ?? [];
      this.log({
        ...logBase,
        status,
        ...(fault ? { fault: fault.kind } : {}),
        errorCodes: errors.flatMap((e) => (typeof e.extensions?.['code'] === 'string' ? [e.extensions['code']] : [])),
        userErrorCodes: collectUserErrorCodes(payload['data']),
        requestedCost: requested,
        ...extra,
      });
      return json(payload, status);
    };

    if (fault?.kind === 'timeout' && !fault.applied) {
      this.log({ ...logBase, status: 0, fault: 'timeout', errorCodes: [], userErrorCodes: [] });
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }
    if (fault?.kind === 'http' && !fault.applied) {
      this.log({ ...logBase, status: fault.status, fault: 'http', errorCodes: [], userErrorCodes: [] });
      return new Response(fault.body ?? 'Service Unavailable', { status: fault.status });
    }
    if (fault?.kind === 'throttled') {
      const st = { ...this.throttleStatus(), currentlyAvailable: 0 };
      return finish(200, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED', documentation: DOC } }], extensions: this.costExt(requested, null, st) });
    }
    if (fault?.kind === 'graphqlError') {
      return finish(200, { errors: [{ message: fault.message ?? fault.code, extensions: { code: fault.code } }], extensions: this.costExt(requested, null) });
    }
    if (requested > this.options.maxQueryCost) {
      return finish(200, {
        errors: [{ message: `Query cost is ${requested}, which exceeds the single query max cost limit (${this.options.maxQueryCost}).`, extensions: { code: 'MAX_COST_EXCEEDED', cost: requested, maxCost: this.options.maxQueryCost, documentation: DOC } }],
      });
    }
    if (requested > this.bucket.currentlyAvailable) {
      return finish(200, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED', documentation: DOC } }], extensions: this.costExt(requested, null) });
    }

    // Required @idempotent.
    if (isMutation && this.options.requireIdempotency && !idemDirective && names.some((n) => IDEMPOTENT_REQUIRED.has(n))) {
      this.violations.push(`${names.join(',')}: missing @idempotent directive`);
      return finish(200, { errors: [{ message: 'The @idempotent directive is required for this mutation.', extensions: { code: 'BAD_REQUEST' } }], extensions: this.costExt(requested, null) });
    }

    // Idempotent replay.
    let fingerprint = '';
    if (isMutation && idemKey) {
      fingerprint = stableStringify(rootFields.map((f) => [f.name.value, argsOf(f, ctx)]));
      const rec = this.idem.get(idemKey);
      if (rec && this.clock.now() - rec.at < this.options.idempotencyTtlMs) {
        if (rec.fingerprint !== fingerprint) {
          return finish(200, { errors: [{ message: 'The idempotency key was already used with different parameters.', extensions: { code: 'IDEMPOTENCY_KEY_PARAMETER_MISMATCH' } }], extensions: this.costExt(requested, null) });
        }
        if (rec.failed && this.options.replayFailed === 'previous_attempt_failed') {
          return finish(200, { errors: [{ message: 'The previous attempt with this idempotency key failed.', extensions: { code: 'IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED' } }], extensions: this.costExt(requested, null) }, { replay: true });
        }
        return finish(200, structuredClone(rec.body), { replay: true });
      }
    }

    // Stale-change fault: a concurrent writer moves the quantities just before this request.
    if (fault?.kind === 'staleChange' && isMutation) {
      for (const f of rootFields) if (STOCK_MUTATIONS.has(f.name.value)) this.driftTargets(f, ctx, fault.name ?? 'available', fault.drift ?? 1);
    }

    // Execute.
    let data: Obj = {};
    let failedAny = false;
    let abort: SimAbort | undefined;
    try {
      if (isMutation) {
        for (const f of rootFields) {
          const key = f.alias?.value ?? f.name.value;
          const fn = MUTATIONS[f.name.value];
          if (!fn) throw new SimAbort([{ message: `Field '${f.name.value}' doesn't exist on type 'Mutation'`, path: [key], extensions: { code: 'undefinedField', typeName: 'Mutation', fieldName: f.name.value } }]);
          let result: MutationResult;
          try {
            result = fault?.kind === 'userError' ? userErrorResult(f.name.value, { field: null, message: fault.message ?? fault.code, code: fault.code }) : fn(env, argsOf(f, ctx));
          } catch (e) {
            if (e instanceof AccessDenied) {
              ctx.errors.push({ message: `Access denied for ${f.name.value} field. Required access: ${e.required.map((s) => `\`${s}\``).join(' or ')} access scope.`, path: [key], extensions: { code: 'ACCESS_DENIED', documentation: 'https://shopify.dev/api/usage/access-scopes' } });
              data[key] = null;
              continue;
            }
            throw e;
          }
          if (result.failed) failedAny = true;
          data[key] = f.selectionSet ? project(result.payload, f.selectionSet, ctx, [key]) : null;
        }
      } else {
        const projected = project(queryRoot(ctx), op.selectionSet, ctx, []);
        data = projected as Obj;
        ctx.actualCost -= 1; // the root object itself is free
      }
    } catch (e) {
      if (e instanceof SimAbort) abort = e;
      else if (e instanceof SimFieldError) abort = new SimAbort([{ message: e.message, extensions: { code: e.code } }]);
      else throw e;
    }
    if (abort) return finish(200, { errors: abort.errors });

    const actual = Math.max(1, ctx.actualCost) + (isMutation ? 10 * rootFields.length : 0);
    this.bucket.currentlyAvailable = Math.max(0, this.bucket.currentlyAvailable - Math.min(actual, requested));
    const payload: Obj = { data, ...(ctx.errors.length > 0 ? { errors: ctx.errors } : {}), extensions: this.costExt(requested, actual) };
    if (isMutation && idemKey) this.idem.set(idemKey, { fingerprint, body: structuredClone(payload), failed: failedAny, at: this.clock.now() });

    if (fault?.kind === 'timeout' && fault.applied) {
      this.log({ ...logBase, status: 0, fault: 'timeout(applied)', errorCodes: [], userErrorCodes: [] });
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }
    if (fault?.kind === 'http' && fault.applied) {
      this.log({ ...logBase, status: fault.status, fault: 'http(applied)', errorCodes: [], userErrorCodes: [] });
      return new Response(fault.body ?? 'Bad Gateway', { status: fault.status });
    }
    return finish(200, payload, { actualCost: actual });
  }

  private driftTargets(f: FieldNode, ctx: Ctx, name: StoredQuantityName, drift: number): void {
    const input = (argsOf(f, ctx)['input'] ?? {}) as Obj;
    const targets = new Set<string>();
    const add = (item: unknown, loc: unknown): void => {
      if (typeof item === 'string' && typeof loc === 'string') targets.add(`${item}|${loc}`);
    };
    for (const c of (input['changes'] as Obj[] | undefined) ?? []) {
      add(c['inventoryItemId'], c['locationId']);
      add(c['inventoryItemId'], (c['from'] as Obj | undefined)?.['locationId']);
      add(c['inventoryItemId'], (c['to'] as Obj | undefined)?.['locationId']);
    }
    for (const q of (input['quantities'] as Obj[] | undefined) ?? []) add(q['inventoryItemId'], q['locationId']);
    for (const t of targets) {
      const [item, loc] = t.split('|') as [string, string];
      if (this.shop.items.has(item) && this.shop.locations.has(loc)) this.shop.changeQuantity(item, loc, name, drift);
    }
  }
}

export function createShopifySim(opts: SimOptions = {}): ShopifySim {
  return new ShopifySim(opts);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function printType(t: { kind: string; type?: unknown; name?: { value: string } }): string {
  if (t.kind === Kind.NON_NULL_TYPE) return `${printType(t.type as never)}!`;
  if (t.kind === Kind.LIST_TYPE) return `[${printType(t.type as never)}]`;
  return t.name?.value ?? '?';
}

function collectRootFields(set: SelectionSetNode, fragments: Record<string, FragmentDefinitionNode>): FieldNode[] {
  const out: FieldNode[] = [];
  for (const s of set.selections) {
    if (s.kind === Kind.FIELD) out.push(s);
    else if (s.kind === Kind.INLINE_FRAGMENT) out.push(...collectRootFields(s.selectionSet, fragments));
    else {
      const f = fragments[s.name.value];
      if (f) out.push(...collectRootFields(f.selectionSet, fragments));
    }
  }
  return out;
}

function collectUserErrorCodes(data: unknown): string[] {
  const codes: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Obj)) {
        if (k === 'userErrors' && Array.isArray(x)) for (const e of x) if (e && typeof (e as Obj)['code'] === 'string') codes.push((e as Obj)['code'] as string);
        walk(x);
      }
    }
  };
  walk(data);
  return codes;
}
