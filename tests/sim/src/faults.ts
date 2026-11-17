import type { StoredQuantityName } from './model.js';

export type Fault =
  /** The request never gets an answer. `applied: true` means a mutation was executed first (lost response). */
  | { kind: 'timeout'; applied?: boolean }
  /** HTTP-level failure (502, 503, 402 frozen shop, ...). `applied: true` executes the mutation first. */
  | { kind: 'http'; status: number; body?: string; applied?: boolean }
  /** Cost-based `THROTTLED` error, nothing executed. */
  | { kind: 'throttled' }
  /**
   * Someone else changes the quantity just before the request runs (a real concurrent writer): `drift` is added to
   * `name` (default `available` +1) at every level the mutation targets, so `changeFromQuantity` is genuinely stale.
   */
  | { kind: 'staleChange'; drift?: number; name?: StoredQuantityName }
  /** Mutation payload with a single user error (e.g. `SERVICE_UNAVAILABLE`, `ADJUST_QUANTITIES_FAILED`); nothing executed. */
  | { kind: 'userError'; code: string; message?: string }
  /** Top-level GraphQL error with `extensions.code` (e.g. `IDEMPOTENCY_CONCURRENT_REQUEST`); nothing executed. */
  | { kind: 'graphqlError'; code: string; message?: string };

export interface FaultRule {
  /**
   * Root field name (`inventoryAdjustQuantities`, `order`, `metafieldsSet`, ...), `oauth` for the token endpoint,
   * or `*` for every request.
   */
  operation: string;
  /** 1-based call numbers of that operation: one number, a list, or a `{from, to}` range. Default: every call. */
  calls?: number | number[] | { from?: number; to?: number };
  /** Maximum number of times the rule fires. */
  times?: number;
  fault: Fault;
}

interface Armed extends FaultRule {
  id: number;
  fired: number;
}

export class FaultInjector {
  private rules: Armed[] = [];
  private counts = new Map<string, number>();
  private seq = 0;

  /** Arms a rule; returns a function that removes it. */
  add(rule: FaultRule): () => void {
    const armed: Armed = { ...rule, id: ++this.seq, fired: 0 };
    this.rules.push(armed);
    return () => {
      this.rules = this.rules.filter((r) => r.id !== armed.id);
    };
  }

  clear(): void {
    this.rules = [];
  }

  /** Number of requests seen so far for an operation (root field name). */
  callCount(operation: string): number {
    return this.counts.get(operation) ?? 0;
  }

  resetCounts(): void {
    this.counts.clear();
  }

  /** Registers one request carrying these operations and returns the first rule that fires, with the operation it fired for. */
  observe(operations: string[]): { rule: FaultRule; operation: string } | undefined {
    let hit: { rule: FaultRule; operation: string } | undefined;
    for (const op of ['*', ...operations]) {
      const n = (this.counts.get(op) ?? 0) + 1;
      this.counts.set(op, n);
      if (hit) continue;
      for (const r of this.rules) {
        if (r.operation !== op) continue;
        if (r.times !== undefined && r.fired >= r.times) continue;
        if (!matchCalls(r.calls, n)) continue;
        r.fired += 1;
        hit = { rule: r, operation: op };
        break;
      }
    }
    return hit;
  }
}

function matchCalls(calls: FaultRule['calls'], n: number): boolean {
  if (calls === undefined) return true;
  if (typeof calls === 'number') return calls === n;
  if (Array.isArray(calls)) return calls.includes(n);
  return n >= (calls.from ?? 1) && n <= (calls.to ?? Number.POSITIVE_INFINITY);
}
