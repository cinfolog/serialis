/** `extensions.cost.throttleStatus` of an Admin GraphQL response. */
export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

/**
 * Per-shop estimate of the GraphQL cost bucket (spec 12.4, 12.8). One instance per shop (it lives in
 * the shop's object), shared by every client of that shop. Before a request the caller reserves its
 * estimated cost and waits if the bucket is too low; each response resets the estimate from
 * Shopify's own `throttleStatus`.
 */
export class CostThrottle {
  private maximum: number;
  private available: number;
  private restoreRate: number;
  private updatedAt: number;
  private readonly now: () => number;

  /** Defaults are the Standard plan figures (100 points/s) until the first response tells otherwise. */
  constructor(options: { maximumAvailable?: number; restoreRate?: number; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.maximum = options.maximumAvailable ?? 1000;
    this.available = this.maximum;
    this.restoreRate = options.restoreRate ?? 100;
    this.updatedAt = this.now();
  }

  /** Points available now, counting the restore since the last update. */
  currentlyAvailable(): number {
    const elapsed = Math.max(0, this.now() - this.updatedAt) / 1000;
    return Math.min(this.maximum, this.available + elapsed * this.restoreRate);
  }

  get maximumAvailable(): number {
    return this.maximum;
  }

  /** Milliseconds to wait before `cost` points are available (0 if they are). */
  waitTimeFor(cost: number): number {
    const needed = Math.min(cost, this.maximum);
    const missing = needed - this.currentlyAvailable();
    if (missing <= 0) return 0;
    return Math.ceil((missing / this.restoreRate) * 1000);
  }

  /** Debits the estimated cost so that concurrent requests of the same shop do not all go at once. */
  reserve(cost: number): void {
    this.available = this.currentlyAvailable() - Math.min(cost, this.maximum);
    this.updatedAt = this.now();
  }

  /** Authoritative update from a response. */
  update(status: ThrottleStatus): void {
    if (status.maximumAvailable > 0) this.maximum = status.maximumAvailable;
    if (status.restoreRate > 0) this.restoreRate = status.restoreRate;
    this.available = Math.min(this.maximum, Math.max(0, status.currentlyAvailable));
    this.updatedAt = this.now();
  }
}
