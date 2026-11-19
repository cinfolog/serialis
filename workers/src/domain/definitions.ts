/**
 * Metafield definitions created by the app (spec 13.4 « Définitions créées à l'installation »).
 * Recette 2 (5.3): without a definition, Shopify shows no card for `serialis.units` on the order page.
 * The ORDER definition (namespace `serialis`, key `units`, type `json`, the type written by the sync) is created
 * once by the task `definitions`, scheduled at installation, at reactivation and at the start of an object that
 * does not have it yet (upgrade of an installed shop). An existing definition (reinstallation, `TAKEN`) is reused.
 * Failures that are not transient (scope refused, invalid definition) are logged and retried a day later: a
 * missing card never blocks the synchronization, which keeps writing the metafield.
 * Recette 3: the definition is pinned (`pin: true` at creation; `metafieldDefinitionPin` once for a definition that
 * already exists unpinned). Done once per shop (`meta.order_metafield_definition_pinned`): a merchant who unpins it
 * later is not overruled.
 */
import { ShopifyError } from '@serialis/shopify';
import { logEvent } from '../log.js';
import { TASK_PRIORITY } from '../task-kinds.js';
import type { TaskResult } from '../tasks.js';
import type { DomainContext } from './context.js';

export const DEFINITIONS_KEY = 'definitions';
const META_KEY = 'order_metafield_definition';
const PINNED_KEY = 'order_metafield_definition_pinned';
const RETRY_MS = 24 * 3_600_000;

/** Shopify keeps one name and one description per definition: both languages are given (FR first, default market). */
export const ORDER_UNITS_DEFINITION = {
  ownerType: 'ORDER',
  namespace: 'serialis',
  key: 'units',
  type: 'json',
  pin: true,
  name: 'Serialis : refs des unités / unit refs',
  description:
    "Refs (numéros de série) des unités de chaque ligne, tenues par Serialis ; copie en lecture, toute modification est rétablie. / Unit refs (serial numbers) of each line, kept by Serialis; read-only copy, edits are reverted.",
} as const;

const FIND = `query SerialisOrderUnitsDefinition {
  metafieldDefinitions(first: 1, ownerType: ORDER, namespace: "serialis", key: "units") { nodes { id pinnedPosition } }
}`;

const CREATE = `mutation SerialisCreateOrderUnitsDefinition($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) { createdDefinition { id } userErrors { field message code } }
}`;

const PIN = `mutation SerialisPinOrderUnitsDefinition($id: ID!) {
  metafieldDefinitionPin(definitionId: $id) { pinnedDefinition { id pinnedPosition } userErrors { field message code } }
}`;

type Found = { metafieldDefinitions: { nodes: { id: string; pinnedPosition?: number | null }[] } };

/** Schedules the task when the definition is not known yet, or not pinned yet. Synchronous (inside a transaction). */
export function ensureDefinitionsTask(ctx: Pick<DomainContext, 'sql' | 'enqueueTask'>, now = Date.now()): void {
  if (ctx.sql.exec('SELECT 1 FROM meta WHERE key IN (?, ?)', META_KEY, PINNED_KEY).toArray().length === 2) return;
  if (ctx.sql.exec('SELECT 1 FROM tasks WHERE key = ?', DEFINITIONS_KEY).toArray().length > 0) return;
  ctx.enqueueTask({ key: DEFINITIONS_KEY, kind: 'definitions', priority: TASK_PRIORITY.definitions }, now);
}

/** Forgets the known definition (reactivation: the merchant may have deleted it meanwhile). */
export function forgetDefinitions(ctx: Pick<DomainContext, 'sql'>): void {
  ctx.sql.exec('DELETE FROM meta WHERE key IN (?, ?)', META_KEY, PINNED_KEY);
}

export async function runEnsureDefinitions(ctx: DomainContext): Promise<TaskResult> {
  const client = ctx.client();
  try {
    const found = (await client.request<Found>(FIND, { estimatedCost: 5 })).data.metafieldDefinitions.nodes[0] ?? null;
    let id = found?.id ?? null;
    let pinned = found ? found.pinnedPosition != null : false;
    if (!id) {
      const { data } = await client.request<{ metafieldDefinitionCreate: { createdDefinition: { id: string } | null; userErrors: { code: string | null; message: string }[] } }>(CREATE, {
        variables: { definition: ORDER_UNITS_DEFINITION },
        estimatedCost: 10,
      });
      const res = data.metafieldDefinitionCreate;
      id = res.createdDefinition?.id ?? null;
      pinned = id !== null;
      if (!id && res.userErrors.some((e) => e.code === 'TAKEN')) {
        const again = (await client.request<Found>(FIND, { estimatedCost: 5 })).data.metafieldDefinitions.nodes[0] ?? null;
        id = again?.id ?? null;
        pinned = again ? again.pinnedPosition != null : false;
      }
      if (!id) {
        logEvent('warn', 'definitions.refused', { errors: res.userErrors.map((e) => `${e.code ?? ''}:${e.message}`).join('; ') });
        return { rescheduleAt: Date.now() + RETRY_MS };
      }
      logEvent('info', 'definitions.created', { definition: id });
    }
    const definition = id;
    ctx.storage.transactionSync(() => ctx.repo.setMeta(META_KEY, definition));
    if (ctx.repo.meta(PINNED_KEY) === null) {
      if (!pinned) {
        const { data } = await client.request<{ metafieldDefinitionPin: { pinnedDefinition: { id: string } | null; userErrors: { code: string | null; message: string }[] } }>(PIN, {
          variables: { id: definition },
          estimatedCost: 10,
        });
        const res = data.metafieldDefinitionPin;
        // Already pinned: done. Limit of pinned definitions reached (the merchant's choice): logged, not retried.
        if (!res.pinnedDefinition && !res.userErrors.some((e) => e.code === 'ALREADY_PINNED')) {
          logEvent('warn', 'definitions.pin_refused', { definition, errors: res.userErrors.map((e) => `${e.code ?? ''}:${e.message}`).join('; ') });
        } else {
          logEvent('info', 'definitions.pinned', { definition });
        }
      }
      ctx.storage.transactionSync(() => ctx.repo.setMeta(PINNED_KEY, '1'));
    }
    return undefined;
  } catch (error) {
    // Access denied or invalid query: not transient, retried tomorrow without burning the task's attempts.
    if (error instanceof ShopifyError && error.kind === 'graphql') {
      logEvent('warn', 'definitions.refused', { error: error.message });
      return { rescheduleAt: Date.now() + RETRY_MS };
    }
    throw error;
  }
}
