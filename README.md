# Serialis

App Shopify de gestion des stocks sérialisés : une ref par unité, liée à une variante et à un emplacement, attribuée automatiquement à chaque commande, synchronisée avec le stock Shopify. Hébergement Cloudflare (Workers, Durable Objects SQLite, D1, KV, R2). Spécification : [`docs/spec/spec.md`](docs/spec/spec.md).

## Organisation (spec 19.1)

| Dossier | Contenu | État |
|---|---|---|
| `core/` | Domaine pur : états, transitions, invariants, règles d'attribution | Moteur de synchronisation complet (MVP) |
| `workers/` | Worker principal, objet `ShopStore` par boutique | Webhooks, tâches, outbox, `sync_order`, contrôle des niveaux, réconciliations R1 à R3, API `/api/v1`, service de l'app (`app/dist`) |
| `db/shop/`, `db/registry/` | Migrations SQL (base de boutique, annuaire D1) | Socle |
| `app/`, `extensions/`, `api/`, `services/`, `tests/` | App admin, extensions, contrat d'API, client Shopify, simulateur | MVP ; API publique à clés à venir |
| `shopify.app.{dev,pilot,production}.toml` | Une configuration par app Shopify | Scopes et webhooks du MVP |
| `wrangler.jsonc` | Environnements Cloudflare : dev, staging, pilot, production | Identifiants à renseigner |

## Démarrer

```sh
pnpm install
pnpm --filter @serialis/admin build   # app/dist, servie par le Worker
pnpm test        # tous les paquets ; workers dans workerd, de bout en bout avec le simulateur Shopify
pnpm typecheck
pnpm dev         # wrangler dev
```

## Mise en place (une fois par environnement)

1. **Cloudflare** : créer la base D1, l'espace KV et le compartiment R2, puis reporter les identifiants dans `wrangler.jsonc` :
   ```sh
   wrangler d1 create serialis-registry-staging --jurisdiction eu
   wrangler kv namespace create serialis-shop-routing-staging
   wrangler r2 bucket create serialis-files-staging --jurisdiction eu
   wrangler secret put SHOPIFY_API_SECRET --env staging
   ```
2. **Shopify** : créer l'app dans le Dev Dashboard de l'organisation Serialis (une par environnement), reporter `client_id` dans le `shopify.app.*.toml` correspondant.
3. **GitHub** : secrets d'environnement `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SHOPIFY_CLI_TOKEN` (compte de service avec la permission « App development »).
4. Déployer : action **Deploy** (manuelle), environnement `staging`.

## Lot 0 — reste à faire

Routage boutique → objet par KV et D1 (juridiction `eu`, spec 10.5) ; installation et échange de jetons ; tâches et alarmes ; outbox ; client Shopify (limiteur par coût, idempotence) ; sauvegardes R2 ; observabilité (Sentry, Analytics Engine) ; simulateur de l'API Shopify ; boutique de recette ; levée de PV-1, PV-9 à PV-12, PV-17, PV-28 ; demandes PV-2 et PV-18.
