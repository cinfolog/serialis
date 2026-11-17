import type { FieldNode, FragmentDefinitionNode, SelectionNode, SelectionSetNode } from 'graphql';
import { Kind, valueFromASTUntyped } from 'graphql';
import type { Shop } from './shop.js';

export interface GqlError {
  message: string;
  path?: (string | number)[];
  locations?: { line: number; column: number }[];
  extensions?: Record<string, unknown>;
}

/** Error attached to one field: the field becomes null and the error is reported, the rest of the response survives. */
export class SimFieldError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Missing access scope; the message is completed with the field name by the projector. */
export class AccessDenied extends Error {
  constructor(readonly required: string[]) {
    super('access denied');
  }
}

/** Error that fails the whole request (validation errors: no `data` at all). */
export class SimAbort extends Error {
  constructor(readonly errors: GqlError[]) {
    super(errors[0]?.message ?? 'abort');
  }
}

export interface Ctx {
  shop: Shop;
  scopes: Set<string>;
  variables: Record<string, unknown>;
  fragments: Record<string, FragmentDefinitionNode>;
  errors: GqlError[];
  actualCost: number;
  /** Throws AccessDenied unless at least one of the scopes is granted. */
  requireAny(scopes: string[]): void;
}

export type Resolver = (args: Record<string, unknown>) => unknown;

export function argsOf(field: FieldNode, ctx: Pick<Ctx, 'variables'>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.arguments ?? []) out[a.name.value] = valueFromASTUntyped(a.value, ctx.variables);
  return out;
}

const CONCRETE = new Set([
  'Order', 'LineItem', 'ProductVariant', 'Product', 'InventoryItem', 'InventoryLevel', 'Location', 'FulfillmentOrder',
  'FulfillmentOrderLineItem', 'Fulfillment', 'Refund', 'Return', 'ReverseFulfillmentOrder', 'Metafield', 'BulkOperation',
]);

function typeMatches(cond: string | undefined, value: Record<string, unknown>): boolean {
  if (!cond) return true;
  const tn = value['__typename'];
  if (typeof tn !== 'string') return true;
  if (!CONCRETE.has(cond)) return true; // interface or union: accept
  return cond === tn;
}

function flatten(set: SelectionSetNode, value: Record<string, unknown>, ctx: Ctx, into: FieldNode[]): void {
  for (const sel of set.selections as readonly SelectionNode[]) {
    if (sel.kind === Kind.FIELD) into.push(sel);
    else if (sel.kind === Kind.INLINE_FRAGMENT) {
      if (typeMatches(sel.typeCondition?.name.value, value)) flatten(sel.selectionSet, value, ctx, into);
    } else {
      const frag = ctx.fragments[sel.name.value];
      if (!frag) throw new SimAbort([{ message: `Fragment ${sel.name.value} was used, but not defined`, extensions: { code: 'undefinedFragment' } }]);
      if (typeMatches(frag.typeCondition.name.value, value)) flatten(frag.selectionSet, value, ctx, into);
    }
  }
}

/** Projects a resolved value through a selection set. Function-valued properties are resolvers receiving the field arguments. */
export function project(value: unknown, set: SelectionSetNode, ctx: Ctx, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v, i) => project(v, set, ctx, [...path, i]));
  if (typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  ctx.actualCost += 1;
  const fields: FieldNode[] = [];
  flatten(set, obj, ctx, fields);
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias?.value ?? f.name.value;
    const name = f.name.value;
    const fpath = [...path, key];
    if (name === '__typename') {
      out[key] = obj['__typename'] ?? null;
      continue;
    }
    if (!(name in obj)) {
      throw new SimAbort([{ message: `Field '${name}' doesn't exist on type '${String(obj['__typename'] ?? 'Object')}'`, path: fpath, extensions: { code: 'undefinedField', typeName: obj['__typename'], fieldName: name } }]);
    }
    let resolved: unknown;
    try {
      const raw = obj[name];
      resolved = typeof raw === 'function' ? (raw as Resolver)(argsOf(f, ctx)) : raw;
    } catch (e) {
      if (e instanceof AccessDenied) {
        const need = e.required.map((s) => `\`${s}\``).join(' or ');
        ctx.errors.push({
          message: `Access denied for ${name} field. Required access: ${need} access scope.`,
          path: fpath,
          extensions: { code: 'ACCESS_DENIED', documentation: 'https://shopify.dev/api/usage/access-scopes', requiredAccess: `${need} access scope.` },
        });
        out[key] = null;
        continue;
      }
      if (e instanceof SimFieldError) {
        ctx.errors.push({ message: e.message, path: fpath, extensions: { code: e.code, ...e.extra } });
        out[key] = null;
        continue;
      }
      throw e;
    }
    out[key] = f.selectionSet ? project(resolved, f.selectionSet, ctx, fpath) : resolved;
  }
  return out;
}

// ---- cost ---------------------------------------------------------------------------------------

/** Static (requested) cost: objects cost 1, connections multiply the cost of their nodes by `first`/`last`. */
export function staticCost(set: SelectionSetNode, ctx: Pick<Ctx, 'variables' | 'fragments'>): number {
  let total = 0;
  const visit = (s: SelectionSetNode, multiplier: number): void => {
    for (const sel of s.selections) {
      if (sel.kind === Kind.INLINE_FRAGMENT) visit(sel.selectionSet, multiplier);
      else if (sel.kind === Kind.FRAGMENT_SPREAD) {
        const f = ctx.fragments[sel.name.value];
        if (f) visit(f.selectionSet, multiplier);
      } else if (sel.selectionSet) {
        const args = argsOf(sel, ctx);
        const n = typeof args['first'] === 'number' ? args['first'] : typeof args['last'] === 'number' ? args['last'] : undefined;
        if (sel.name.value === 'edges') {
          visit(sel.selectionSet, multiplier);
        } else if (sel.name.value === 'nodes' || sel.name.value === 'node') {
          total += multiplier;
          visit(sel.selectionSet, multiplier);
        } else if (n !== undefined) {
          total += multiplier;
          visit(sel.selectionSet, multiplier * n);
        } else {
          total += multiplier;
          visit(sel.selectionSet, multiplier);
        }
      }
    }
  };
  visit(set, 1);
  return total;
}

// ---- connections ----------------------------------------------------------------------------------

export function encodeCursor(index: number): string {
  return btoa(`sim:${index}`);
}
function decodeCursor(c: unknown): number {
  if (typeof c !== 'string') return -1;
  try {
    const m = /^sim:(\d+)$/.exec(atob(c));
    return m ? Number(m[1]) : -1;
  } catch {
    return -1;
  }
}

/** Builds a relay connection over an in-memory list. `first`/`last` is mandatory, like on the real API. */
export function connection<T>(typeName: string, field: string, items: T[], args: Record<string, unknown>): Record<string, unknown> {
  const first = args['first'];
  const last = args['last'];
  if (typeof first !== 'number' && typeof last !== 'number') {
    throw new SimAbort([{ message: `you must provide one of \`first\` or \`last\` to properly paginate the \`${field}\` field.`, extensions: { code: 'BAD_REQUEST' } }]);
  }
  const limit = Math.min(250, (typeof first === 'number' ? first : last) as number);
  let start = 0;
  let end = items.length;
  if (typeof first === 'number') {
    start = decodeCursor(args['after']) + 1;
    end = Math.min(items.length, start + limit);
  } else {
    end = args['before'] ? Math.min(items.length, decodeCursor(args['before'])) : items.length;
    start = Math.max(0, end - limit);
  }
  const page = items.slice(start, end);
  const edges = page.map((node, i) => ({ __typename: `${typeName}Edge`, cursor: encodeCursor(start + i), node }));
  return {
    __typename: `${typeName}Connection`,
    nodes: page,
    edges,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
    },
  };
}

/** Minimal search-syntax filter: `field:value`, `field:>=value`, joined by AND (implicit or explicit). */
export function matchQuery(query: unknown, getters: Record<string, (() => string | number | undefined) | undefined>): boolean {
  if (typeof query !== 'string' || query.trim() === '') return true;
  const terms = query.split(/\s+(?:AND\s+)?/).filter((t) => t && t !== 'AND');
  for (const term of terms) {
    const m = /^([a-z_]+):(>=|<=|>|<|=)?(.*)$/.exec(term);
    if (!m) continue;
    const getter = getters[m[1] as string];
    if (!getter) continue;
    const actual = getter();
    const op = m[2] ?? '=';
    const wanted = (m[3] as string).replace(/^['"]|['"]$/g, '');
    if (actual === undefined) return false;
    const a = typeof actual === 'number' ? actual : String(actual);
    const w = typeof actual === 'number' ? Number(wanted) : wanted;
    const ok = op === '=' ? a === w : op === '>=' ? a >= w : op === '<=' ? a <= w : op === '>' ? a > w : a < w;
    if (!ok) return false;
  }
  return true;
}
