import type { WebhookEvent } from './model.js';
import type { Clock } from './util.js';
import { hmacSha256Base64, mulberry32 } from './util.js';

export const DEFAULT_WEBHOOK_SECRET = 'sim-webhook-secret';

/** Builds the signed HTTP request Shopify would send for an event. */
export async function signedWebhookRequest(event: WebhookEvent, url: string, secret: string): Promise<Request> {
  const body = JSON.stringify(event.payload);
  return new Request(url, {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Topic': event.topic,
      'X-Shopify-Hmac-Sha256': await hmacSha256Base64(secret, body),
      'X-Shopify-Shop-Domain': event.shopDomain,
      'X-Shopify-Webhook-Id': event.id,
      'X-Shopify-Triggered-At': event.triggeredAt,
      'X-Shopify-API-Version': event.apiVersion,
    },
  });
}

export interface DeliveryOptions {
  /** Webhook endpoint of the app (e.g. `https://hooks.serialis.dev/webhooks/shopify`). */
  url: string;
  /** Sender, typically `SELF.fetch` in workerd tests or `(r) => worker.fetch(r, env)`. */
  send: (request: Request) => Promise<Response>;
  /** HMAC secret (default: the sim's `webhookSecret`). Use another one to test bad signatures. */
  secret?: string;
  /** Events to deliver (default: every event emitted and not yet delivered). */
  events?: WebhookEvent[];
  /** Extra copies of each event (same webhook id, like a Shopify retry). Number, or per event. */
  duplicate?: number | ((event: WebhookEvent) => number);
  /** Delivery delay in ms after the trigger time, per event; a delayed webhook naturally arrives after later ones. */
  delayMs?: number | ((event: WebhookEvent, copy: number) => number);
  /** Reorders the deliveries after delays are applied. */
  reorder?: 'reverse' | 'shuffle' | ((events: WebhookEvent[]) => WebhookEvent[]);
  /** Probability in [0, 1] that an event is lost (never delivered, all copies). */
  drop?: number;
  /** Seed of the RNG used by `drop` and `shuffle` (default 1). */
  seed?: number;
  /** Fire everything at once instead of one after the other. */
  concurrent?: boolean;
  /** Advance the sim clock to each delivery time (default true). */
  advanceClock?: boolean;
  /** Real waiting between deliveries instead of only moving the sim clock (default false). */
  realTime?: boolean;
}

export interface Delivery {
  event: WebhookEvent;
  copy: number;
  /** Simulated delivery time (ms epoch). */
  at: number;
  response?: Response;
  status?: number;
  error?: unknown;
}

export interface DeliveryReport {
  deliveries: Delivery[];
  dropped: WebhookEvent[];
}

/** Delivers the shop's webhooks to the app, with chaos options (spec 18.3). */
export class WebhookDelivery {
  private cursor = 0;

  constructor(
    private readonly events: WebhookEvent[],
    private readonly clock: Clock,
    private readonly defaults: { secret: string },
  ) {}

  /** Events emitted and not delivered yet. */
  pending(): WebhookEvent[] {
    return this.events.slice(this.cursor);
  }

  /** Signed requests for events, without sending or consuming them. */
  async requests(url: string, events: WebhookEvent[] = this.pending(), secret: string = this.defaults.secret): Promise<Request[]> {
    return Promise.all(events.map((e) => signedWebhookRequest(e, url, secret)));
  }

  async deliver(opts: DeliveryOptions): Promise<DeliveryReport> {
    const rng = mulberry32(opts.seed ?? 1);
    const secret = opts.secret ?? this.defaults.secret;
    let chosen: WebhookEvent[];
    if (opts.events) chosen = opts.events;
    else {
      chosen = this.pending();
      this.cursor = this.events.length;
    }
    const dropped: WebhookEvent[] = [];
    let plan: { event: WebhookEvent; copy: number; at: number }[] = [];
    for (const event of chosen) {
      if (opts.drop !== undefined && rng() < opts.drop) {
        dropped.push(event);
        continue;
      }
      const extra = typeof opts.duplicate === 'function' ? opts.duplicate(event) : (opts.duplicate ?? 0);
      for (let copy = 0; copy <= extra; copy++) {
        const delay = typeof opts.delayMs === 'function' ? opts.delayMs(event, copy) : (opts.delayMs ?? 0);
        plan.push({ event, copy, at: Date.parse(event.triggeredAt) + delay });
      }
    }
    plan = plan.map((p, i) => ({ ...p, i })).sort((a, b) => a.at - b.at || a.i - b.i);
    if (opts.reorder === 'reverse') plan.reverse();
    else if (opts.reorder === 'shuffle') {
      for (let i = plan.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [plan[i], plan[j]] = [plan[j] as (typeof plan)[number], plan[i] as (typeof plan)[number]];
      }
    } else if (typeof opts.reorder === 'function') {
      const order = opts.reorder(plan.map((p) => p.event));
      const used = new Set<number>();
      plan = order.map((e) => {
        const idx = plan.findIndex((p, k) => p.event === e && !used.has(k));
        used.add(idx);
        return plan[idx] as (typeof plan)[number];
      });
    }

    const sendOne = async (p: { event: WebhookEvent; copy: number; at: number }): Promise<Delivery> => {
      if ((opts.advanceClock ?? true) && p.at > this.clock.now()) {
        if (opts.realTime) await new Promise((r) => setTimeout(r, Math.min(p.at - this.clock.now(), 50)));
        this.clock.advance(p.at - this.clock.now());
      }
      const d: Delivery = { event: p.event, copy: p.copy, at: p.at };
      try {
        const res = await opts.send(await signedWebhookRequest(p.event, opts.url, secret));
        d.response = res;
        d.status = res.status;
      } catch (error) {
        d.error = error;
      }
      return d;
    };

    const deliveries: Delivery[] = [];
    if (opts.concurrent) deliveries.push(...(await Promise.all(plan.map(sendOne))));
    else for (const p of plan) deliveries.push(await sendOne(p));
    return { deliveries, dropped };
  }
}
