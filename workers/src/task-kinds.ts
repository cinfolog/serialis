/** Task kinds of the shop object (spec 12.2) and their priority (lower runs first). */
export const TASK_PRIORITY = {
  // Hold placement and release go first (spec 12.2 "Exécution"); they run through the outbox.
  sync_order: 10,
  resolve: 15,
  process_outbox: 20,
  sync_inventory_level: 25,
  sync_inventory_item: 25,
  sync_product: 30,
  sync_location: 30,
  deliver_webhook: 35,
  reconcile: 40,
  definitions: 45,
  export: 50,
  purge: 50,
} as const;

export type TaskKind = keyof typeof TASK_PRIORITY;

/** Key of the single outbox task (spec 12.2). */
export const OUTBOX_TASK_KEY = 'outbox';
