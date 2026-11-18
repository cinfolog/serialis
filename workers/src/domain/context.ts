import type { AdminGraphqlClient } from '@serialis/shopify';
import type { OutboxEnqueueInput } from '../outbox.js';
import type { EnqueueOutcome, EnqueueTaskInput } from '../tasks.js';
import { DomainRepo } from './repo.js';

/** What the domain needs from the shop object (spec 10.2): its base, its Shopify client, its queues. */
export interface DomainContext {
  readonly sql: SqlStorage;
  readonly storage: DurableObjectStorage;
  readonly repo: DomainRepo;
  readonly shopDomain: string;
  client(): AdminGraphqlClient;
  /** Synchronous, inside the caller's transaction; the outbox task is scheduled with it. */
  queueOutbox(input: OutboxEnqueueInput, now?: number): { id: number; created: boolean };
  /** Synchronous, inside the caller's transaction. */
  enqueueTask(input: EnqueueTaskInput, now?: number): EnqueueOutcome;
}
