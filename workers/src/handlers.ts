/**
 * Pluggable task handlers. The shop object runs the domain handlers itself; a handler registered
 * here takes precedence (tests, later lots). `process_outbox` is built into the shop object.
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

// The domain handlers (sync_order, sync_inventory_level, reconcile, resolve) live in the shop object;
// a handler registered here replaces them (tests). The kinds below have no domain handler yet.
for (const kind of ['sync_inventory_item', 'sync_product', 'sync_location']) {
  registerTaskHandler(kind, loggingNoop(kind));
}
