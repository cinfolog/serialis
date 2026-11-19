/**
 * Transport-neutral API call and result (spec 14.1). The authentication layer (session or ID token
 * for `/api/v1`, API key for the public `api.serialis.dev/v1` later) builds an `ApiCall` with a
 * `Principal`; the shop object runs the same handlers whatever the surface.
 */
import type { ErrorCode, Problem } from '@serialis/contract';
import type { Actor } from '../domain/repo.js';

export interface Principal {
  surface: 'internal' | 'public';
  actor: Actor;
  /** Namespace of `Idempotency-Key` values (14.1: key + API key prefix). */
  idempotencyScope: string;
  /** Public API scopes (14.1); the internal surface has every scope of its user. */
  scopes: readonly string[] | 'all';
}

export interface ApiCall {
  method: string;
  /** Path below the API base, e.g. `/units/123`. */
  path: string;
  query: Record<string, string[]>;
  headers: { idempotencyKey?: string | null; ifMatch?: string | null; ifNoneMatch?: string | null; contentType?: string | null; acceptLanguage?: string | null; extension?: string | null };
  body: string | null;
  principal: Principal;
}

export interface ApiResult {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly detail?: string,
    readonly errors?: Problem['errors'],
    readonly headers: Record<string, string> = {},
  ) {
    super(`${code}: ${detail ?? ''}`);
  }
}

const TITLES: Record<ErrorCode, string> = {
  unauthenticated: 'Authentication required',
  forbidden: 'Forbidden',
  not_found: 'Not found',
  validation_failed: 'Validation failed',
  idempotency_conflict: 'Idempotency-Key reused with another body',
  precondition_failed: 'Precondition failed',
  rate_limited: 'Too many requests',
  unit_not_available: 'Unit not available',
  identifier_conflict: 'Identifier already used',
  invalid_transition: 'Transition not allowed',
  variant_mismatch: 'Variant mismatch',
  location_mismatch: 'Location mismatch',
  ambiguous_ref: 'Ambiguous ref',
  unknown_ref: 'Unknown ref',
  not_tracked: 'Variant not tracked',
  emergency_stop: 'Emergency stop active',
  simulation_expired: 'Simulation missing or expired',
  incompatible_settings: 'Incompatible settings',
};

/** problem+json (RFC 9457) with the stable code of the contract. */
export function problem(status: number, code: ErrorCode, detail?: string, errors?: Problem['errors'], headers: Record<string, string> = {}): ApiResult {
  const body: Problem = { type: `https://serialis.dev/problems/${code}`, title: TITLES[code], status, code, ...(detail ? { detail } : {}), ...(errors ? { errors } : {}) };
  return { status, headers: { 'Content-Type': 'application/problem+json', ...headers }, body: JSON.stringify(body) };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): ApiResult {
  return { status, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

export function noContent(headers: Record<string, string> = {}): ApiResult {
  return { status: 204, headers, body: null };
}

export function toResponse(result: ApiResult, extra: Record<string, string> = {}): Response {
  return new Response(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store', ...result.headers, ...extra } });
}

export function parseBody<T>(call: ApiCall): T {
  if (!call.body) throw new ApiError(400, 'validation_failed', 'JSON body required');
  try {
    return JSON.parse(call.body) as T;
  } catch {
    throw new ApiError(400, 'validation_failed', 'invalid JSON body');
  }
}

export function queryOne(call: ApiCall, name: string): string | undefined {
  const v = call.query[name];
  return v && v.length > 0 ? v[v.length - 1] : undefined;
}

/** Repeated or comma-separated values (`state=AVAILABLE&state=SHIPPED` or `state=AVAILABLE,SHIPPED`). */
export function queryList(call: ApiCall, name: string): string[] {
  return (call.query[name] ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

export function pageLimit(call: ApiCall, max = 250, fallback = 50): number {
  const raw = queryOne(call, 'limit');
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new ApiError(400, 'validation_failed', `limit must be an integer between 1 and ${max}`);
  return n;
}

export function encodeCursor(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    return atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    throw new ApiError(400, 'validation_failed', 'invalid cursor');
  }
}

/** `If-Match` (14.1): checked when sent; a stale value gives 412. */
export function checkIfMatch(call: ApiCall, etag: string): void {
  const sent = call.headers.ifMatch;
  if (!sent || sent === '*') return;
  const values = sent.split(',').map((v) => v.trim().replace(/^W\//, ''));
  if (!values.includes(etag)) throw new ApiError(412, 'precondition_failed', `resource changed (current ETag ${etag})`);
}

export function unitEtag(version: number): string {
  return `"u${version}"`;
}

export function allocationEtag(version: number): string {
  return `"a${version}"`;
}

export function locale(call: ApiCall): 'fr' | 'en' {
  const q = queryOne(call, 'locale') ?? call.headers.acceptLanguage ?? 'fr';
  return q.toLowerCase().startsWith('en') ? 'en' : 'fr';
}

/** Order id in a path: numeric (admin extensions) or GID. */
export function orderGidOf(value: string): string {
  const decoded = decodeURIComponent(value);
  if (/^\d+$/.test(decoded)) return `gid://shopify/Order/${decoded}`;
  if (/^gid:\/\/shopify\/Order\/\d+$/.test(decoded)) return decoded;
  throw new ApiError(404, 'not_found', 'unknown order id');
}

export function iso(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}
