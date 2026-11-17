/**
 * Pluggable task handlers. The domain engine (core/, built in parallel) registers its own handlers
 * later; until then the webhook-driven kinds get a logging no-op so that the pipeline
 * (inbox → task → alarm) runs end to end. `process_outbox` is built into the shop object.
 */
import { logEvent } from './log.js';
import type { TaskHandler } from './tasks.js';

const registry = new Map<string, TaskHandler>();

/** Registers (or replaces) the handler of a task kind; returns a function restoring the previous one. */
export function registerTaskHandler(kind: string, handler: TaskHandler): () => void {
  const previous = registry.get(kind);
  registry.set(kind, handler);
  return () => {
    if (previous) registry.set(kind, previous);
    else registry.delete(kind);
  };
}

export function taskHandler(kind: string): TaskHandler | undefined {
  return registry.get(kind);
}

function loggingNoop(kind: string): TaskHandler {
  return (ctx) => {
    logEvent('info', 'task.noop', { kind, key: ctx.key, attempt: ctx.attempt });
  };
}

for (const kind of ['sync_order', 'resolve', 'sync_inventory_level', 'sync_inventory_item', 'sync_product', 'sync_location']) {
  registerTaskHandler(kind, loggingNoop(kind));
}
