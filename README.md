# Serialis

App Shopify de gestion des stocks sérialisés : une ref par unité, liée à une variante et à un emplacement, attribuée automatiquement à chaque commande, synchronisée avec le stock Shopify. Hébergement Cloudflare (Workers, Durable Objects SQLite, D1, KV, R2). Spécification : [`docs/spec/spec.md`](docs/spec/spec.md).

## Organisation (spec 19.1)

| Dossier | Contenu | État |
|---|---|---|
| `core/` | Domaine pur : états, transitions, invariants, règles d'attribution | Moteur de synchronisation complet (MVP) |
| `workers/` | Worker principal, objet `ShopStore` par boutique | Webhooks, tâches, outbox, `sync_order`, contrôle des niveaux, réconciliations R1 à R4, purge, API `/api/v1` et API publique, service de l'app (`app/dist`) |
| `db/shop/`, `db/registry/` | Migrations SQL (base de boutique, annuaire D1) | Socle |
| `app/`, `extensions/`, `api/`, `services/`, `tests/` | App admin, extensions, contrat d'API, client Shopify, simulateur, tests navigateur | MVP (détail ci-dessous) |
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
3. **GitHub** : secrets d'environnement `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SHOPIFY_CLI_TOKEN` (compte de service avec la permission « App development »). Secrets copiés dans le Worker à chaque déploiement : `SHOPIFY_API_SECRET`, `TOKEN_ENCRYPTION_KEY` et `API_KEY_SEAL_SECRET_V1` (scellement des clés de l'API publique, `openssl rand -base64 32` ; rotation par un nouveau secret `API_KEY_SEAL_SECRET_V2`, l'ancien restant en place tant que des clés l'utilisent).
4. Déployer : action **Deploy** (manuelle), environnement `staging`.

## État du MVP

### Paquets

| Paquet | Rôle |
|---|---|
| `@serialis/core` (`core/`) | Domaine pur : états et transitions (seule source, `pnpm gen:transitions`), invariants, règles d'attribution, cohérence attribution ↔ unité |
| `@serialis/workers` (`workers/`) | Worker Cloudflare et objet `ShopStore` (SQLite) par boutique : installation et jetons, webhooks, tâches et alarmes, outbox, `sync_order`, réconciliations R1 à R4, purge, gel, API interne `/api/v1`, API publique à clés (`/v1` sur `api.`, `/public/v1` ailleurs), service de l'app |
| `@serialis/contract` (`api/contract/`) | Contrat d'API partagé : types, tables de routes, portées, document OpenAPI 3.1 |
| `@serialis/shopify` (`services/shopify/`) | Client Shopify : GraphQL, limiteur par coût, idempotence, reprises, erreurs typées |
| `@serialis/admin` (`app/`) | App d'administration embarquée (React, composants web Polaris) : accueil, assistant, unités, articles suivis, anomalies, imports, réglages, clés d'API, santé |
| `extensions/*` | Blocs admin variante, produit, commande et action de commande |
| `db/shop/`, `db/registry/` | Migrations SQL additives (base de boutique, annuaire D1) |
| `@serialis/shopify-sim` (`tests/sim/`) | Simulateur de l'API Shopify (GraphQL, OAuth, webhooks signés, pannes injectables) |
| `@serialis/ui-tests` (`tests/ui/`) | Tests navigateur Playwright et axe de l'app (T-UX-02, 03, 05, 07) |

Décisions et écarts à la spec : `workers/DECISIONS.md`, `app/DECISIONS.md`, `core/DECISIONS.md`, `extensions/DECISIONS.md`.

### Tests

```sh
pnpm --filter @serialis/admin build     # avant les tests du Worker, qui servent app/dist
pnpm typecheck
pnpm test                               # tous les paquets (Vitest)
pnpm --filter @serialis/workers test    # Worker dans workerd (@cloudflare/vitest-plugin), bout en bout avec le simulateur
VITE_API_MOCK=1 pnpm --filter @serialis/admin build && pnpm --filter @serialis/ui-tests e2e   # navigateur (app en mode mock)
pnpm exec wrangler deploy --dry-run --env staging --outdir /tmp/wo   # paquet du Worker
```

Les tests navigateur remplacent le script Polaris du CDN par un shim hors ligne ; `UI_TESTS_REAL_CDN=1` les relance sur les vrais composants (réseau vers cdn.shopify.com). Navigateur local : `UI_TESTS_BROWSER_CHANNEL=chrome` ou `UI_TESTS_BROWSER_PATH=...`. La CI (`ci.yml`) lance les jobs `check` (build, types, tests, paquet du Worker, audit) et `ui` sur chaque PR.

### Déploiement

Workflow **Deploy** (`deploy.yml`) : tests, migrations D1 de l'annuaire, Worker, secrets du Worker, test de fumée `/healthz`, puis version de l'app Shopify (le Worker toujours avant l'app).

- **staging** : automatique sur un push dont le message de commit contient le marqueur `[deploy:staging]`, ou lancement manuel ;
- **pilot**, **production** : lancement manuel seulement (`workflow_dispatch`, choix de l'environnement). En production, la version Shopify est créée avec `--no-release`, vérifiée sur la boutique de recette, puis publiée à la main par `shopify app release`. Jamais `--allow-deletes` automatiquement.

Secrets GitHub (par environnement) :

| Secret | Usage |
|---|---|
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Déploiement du Worker et migrations D1 |
| `SHOPIFY_API_SECRET` | Secret de l'app Shopify, copié dans le Worker (jetons de session, HMAC des webhooks, échange de jetons) |
| `SHOPIFY_CLI_TOKEN` | Compte de service « App development » pour `shopify app deploy` (étape sautée avec un avertissement s'il manque) |
| `TOKEN_ENCRYPTION_KEY` | Clé AES-256-GCM des jetons Shopify au repos (base64 de 32 octets ; `2:<b64>,1:<b64>` pendant une rotation) |
| `API_KEY_SEAL_SECRET_V1` | Scellement des clés de l'API publique (`openssl rand -base64 32`) ; rotation par `API_KEY_SEAL_SECRET_V2` |

### Écarts restants aux critères de sortie du MVP

- **Vérifications sur une vraie boutique** (comportements de Shopify que le simulateur ne peut pas prouver ; repli de la spec en place) : PV-3 (disposition de retour « contrôle requis »), PV-14 (remise en stock d'une ligne retirée par modification de commande), PV-19 (sujets émis par les retours et échanges, retours en caisse), PV-23 (`Order.updatedAt` lors des changements d'ordres d'expédition), PV-24 (remise en stock à la suppression d'une commande, ajustement négatif à 0), PV-29 (`shop/redact` après réinstallation sous 48 h).
- **Contrôles qui demandent l'admin Shopify réel** : App Bridge (`s-app-nav`, `shopify:navigate`, barre d'enregistrement contextuelle, sélecteur de variantes), noms d'événements et propriétés des composants Polaris, blocs et liens `shopify:admin/...`, iframe embarquée, bloc variante et écran Arrivage de T-UX-02 (`app/DECISIONS.md`, points « à vérifier dans l'admin réel »).
- **Contrôles qui demandent le vrai CDN Polaris** : contrastes, libellés et anneaux de focus internes des composants, Web Vitals (LCP, CLS) — suite `UI_TESTS_REAL_CDN=1` à passer avant la publication, avec la grille d'audit manuelle WCAG 2.2 AA.
- **Observabilité** : journaux structurés et écran Santé seulement ; ni Sentry ni Analytics Engine (`workers/DECISIONS.md`, 63).
- **Écran Santé** : pas de relance d'une tâche arrêtée depuis l'écran, que 12.7 prévoit (aucune route dans le contrat ; `app/DECISIONS.md`, 27).
- **Reconnexion** : l'anomalie `reconnect_required` et les bandeaux sont en place, mais aucun e-mail n'invite le marchand à rouvrir l'app.
- Points notés dans les décisions : réveil horaire du Worker planifié pour les boutiques gelées (64), réservations expirées, transits trop longs et photographie `daily_stats` de R4 (60), utilisateurs sans échange de jeton en ligne (57, PV-9).
