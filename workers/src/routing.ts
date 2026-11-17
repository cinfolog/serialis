/**
 * Shop → object routing (spec 10.5, 11.1, 11.3). The D1 registry is the source of truth; KV
 * `SHOP_ROUTING` holds a copy read on every request. A KV answer "absent" or "not active" is always
 * confirmed by D1 before refusing a request or ignoring a webhook (KV may lag 60 s or more).
 * Every code path obtains the object through `shopStub`, which applies the jurisdiction or the
 * location hint (Cloudflare honours the hint only on the first access).
 */
import type { Env } from './env.js';
import type { ShopStore } from './shop-store.js';

export type ShopRegistryStatus = 'active' | 'inactive' | 'frozen';

export interface ShopRouting {
  objectName: string;
  jurisdiction: 'eu' | null;
  locationHint: DurableObjectLocationHint | null;
  status: ShopRegistryStatus;
}

interface ShopRow {
  shop_domain: string;
  object_name: string;
  jurisdiction: string | null;
  location_hint: string | null;
  status: ShopRegistryStatus;
  installed_at: string;
  uninstalled_at: string | null;
  shopify_shop_gid: string | null;
  install_count: number;
}

const KV_PREFIX = 'shop:';

export function routingKey(shop: string): string {
  return `${KV_PREFIX}${shop}`;
}

/** EU and EEA countries (ISO 3166-1), including the EU outermost regions that have their own code. */
const EU_EEA = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GF', 'GP', 'MQ', 'RE', 'YT', 'MF', 'AX',
]);

const HINTS: ReadonlyArray<[DurableObjectLocationHint, readonly string[]]> = [
  ['enam', ['US', 'CA', 'MX', 'PR', 'GT', 'CR', 'PA', 'DO', 'JM', 'BS', 'HN', 'SV', 'NI', 'TT', 'BB']],
  ['sam', ['BR', 'AR', 'CL', 'CO', 'PE', 'UY', 'PY', 'BO', 'EC', 'VE']],
  ['weur', ['GB', 'CH', 'MC', 'AD', 'SM', 'VA', 'GI', 'JE', 'GG', 'IM']],
  ['eeur', ['UA', 'RS', 'BA', 'MD', 'AL', 'MK', 'ME', 'XK', 'GE', 'AM', 'TR']],
  ['apac', ['JP', 'KR', 'CN', 'HK', 'TW', 'MO', 'SG', 'MY', 'TH', 'VN', 'PH', 'ID', 'IN', 'PK', 'BD', 'LK', 'NP', 'KH', 'MN']],
  ['oc', ['AU', 'NZ', 'FJ', 'PG', 'NC', 'PF']],
  ['me', ['AE', 'SA', 'QA', 'KW', 'BH', 'OM', 'IL', 'JO', 'LB', 'IQ']],
  ['afr', ['ZA', 'NG', 'KE', 'EG', 'MA', 'TN', 'GH', 'DZ', 'SN', 'CI', 'MU', 'TZ', 'UG', 'RW', 'ET']],
];

/** Placement decided once, at the first installation, from the shop's address country (spec 10.5). */
export function placementFor(countryCode: string | null | undefined): Pick<ShopRouting, 'jurisdiction' | 'locationHint'> {
  const code = (countryCode ?? '').toUpperCase();
  if (EU_EEA.has(code)) return { jurisdiction: 'eu', locationHint: null };
  for (const [hint, codes] of HINTS) if (codes.includes(code)) return { jurisdiction: null, locationHint: hint };
  return { jurisdiction: null, locationHint: null };
}

/** Object name with its placement prefix (`eu:` or `global:`), kept in the registry (spec 10.5). */
export function objectNameFor(shop: string, jurisdiction: 'eu' | null): string {
  return `${jurisdiction === 'eu' ? 'eu' : 'global'}:${shop}`;
}

/** The only way to address a shop's object. */
export function shopStub(env: Pick<Env, 'SHOP_STORE' | 'ENVIRONMENT'>, routing: Pick<ShopRouting, 'objectName' | 'jurisdiction' | 'locationHint'>): DurableObjectStub<ShopStore> {
  const namespace = routing.jurisdiction === 'eu' ? euNamespace(env) : env.SHOP_STORE;
  const id = namespace.idFromName(routing.objectName);
  return routing.locationHint ? namespace.get(id, { locationHint: routing.locationHint }) : namespace.get(id);
}

function euNamespace(env: Pick<Env, 'SHOP_STORE' | 'ENVIRONMENT'>): DurableObjectNamespace<ShopStore> {
  try {
    return env.SHOP_STORE.jurisdiction('eu');
  } catch (error) {
    // workerd (wrangler dev, tests) does not implement jurisdictions. Never fall back elsewhere:
    // an EU shop's data must stay in the EU.
    if (env.ENVIRONMENT === 'development') return env.SHOP_STORE;
    throw error;
  }
}

/** KV first; a missing or non-active answer is confirmed by D1 (and the KV copy refreshed). */
export async function resolveRouting(env: Env, shop: string): Promise<ShopRouting | null> {
  const cached = await env.SHOP_ROUTING.get<ShopRouting>(routingKey(shop), 'json');
  if (cached && cached.status === 'active') return cached;
  const row = await registryRow(env, shop);
  if (!row) return null;
  const routing = toRouting(row);
  if (!cached || cached.status !== routing.status || cached.objectName !== routing.objectName) {
    await env.SHOP_ROUTING.put(routingKey(shop), JSON.stringify(routing));
  }
  return routing;
}

export async function registryRow(env: Env, shop: string): Promise<ShopRow | null> {
  return env.REGISTRY.prepare('SELECT * FROM shops WHERE shop_domain = ?').bind(shop).first<ShopRow>();
}

/**
 * Installation or reinstallation in the registry (spec 9.14 step 3). An existing row keeps its object
 * name and placement (fixed at creation, spec 10.5); `install_count` counts installations.
 */
export async function registerInstall(
  env: Env,
  shop: string,
  input: { placement: Pick<ShopRouting, 'jurisdiction' | 'locationHint'>; shopifyShopGid: string | null },
  now = new Date(),
): Promise<ShopRouting> {
  const objectName = objectNameFor(shop, input.placement.jurisdiction);
  await env.REGISTRY.prepare(
    `INSERT INTO shops (shop_domain, object_name, jurisdiction, location_hint, status, installed_at, shopify_shop_gid, install_count)
     VALUES (?, ?, ?, ?, 'active', ?, ?, 1)
     ON CONFLICT (shop_domain) DO UPDATE SET
       status = 'active',
       installed_at = excluded.installed_at,
       uninstalled_at = NULL,
       shopify_shop_gid = COALESCE(excluded.shopify_shop_gid, shops.shopify_shop_gid),
       install_count = shops.install_count + 1
     WHERE shops.status <> 'active'`,
  )
    .bind(shop, objectName, input.placement.jurisdiction, input.placement.locationHint, now.toISOString(), input.shopifyShopGid)
    .run();
  const row = await registryRow(env, shop);
  if (!row) throw new Error('registry write not visible');
  const routing = toRouting(row);
  await env.SHOP_ROUTING.put(routingKey(shop), JSON.stringify(routing));
  return routing;
}

/** `app/uninstalled`: inactive in the registry and KV; the data stays until `shop/redact` (spec 9.14, 16.1). */
export async function markUninstalled(env: Env, shop: string, now = new Date()): Promise<void> {
  await env.REGISTRY.prepare("UPDATE shops SET status = 'inactive', uninstalled_at = ? WHERE shop_domain = ? AND status <> 'inactive'")
    .bind(now.toISOString(), shop)
    .run();
  const row = await registryRow(env, shop);
  if (row) await env.SHOP_ROUTING.put(routingKey(shop), JSON.stringify(toRouting(row)));
}

function toRouting(row: ShopRow): ShopRouting {
  return {
    objectName: row.object_name,
    jurisdiction: row.jurisdiction === 'eu' ? 'eu' : null,
    locationHint: (row.location_hint as DurableObjectLocationHint | null) ?? null,
    status: row.status,
  };
}
