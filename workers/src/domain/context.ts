import type { AdminGraphqlClient } from '@serialis/shopify';
import type { AbandonedOutboxRow, OutboxEnqueueInput } from '../outbox.js';
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
  /** Synchronous: a `dead` task back to `pending`, attempts reset (R2, operator; 12.2). False when not dead. */
  reviveTask(key: string, now?: number): boolean;
  /** Synchronous: a `dead` outbox row back to `pending` at its next revision, outbox task scheduled (12.4). False when not dead. */
  retryOutbox(id: number, now?: number): boolean;
  /**
   * Synchronous: a `dead` outbox row abandoned by an operator (12.4): final, the rows behind it on its
   * serial key run again (outbox task scheduled). Returns the abandoned row, null when not dead.
   */
  abandonOutbox(id: number, by: string | null, now?: number): AbandonedOutboxRow | null;
}
