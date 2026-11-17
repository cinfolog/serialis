# Serialis — règles du dépôt

App Shopify publique de gestion des stocks sérialisés, hébergée sur Cloudflare.

- **La spécification fait foi** : `docs/spec/spec.md`. Toute divergence entre le code et la spec se corrige dans l'un ou l'autre, jamais en silence. Les numéros (EF-xx, F1…F15, S-xx, PV-xx, T-xxx) citent la spec.
- **Tout en TypeScript** (spec 10.3). Identifiants et commentaires de code en anglais ; textes de l'interface en français et en anglais.
- **`core/` reste pur** : aucune dépendance à Workers, Shopify ou SQLite. La table des transitions (`core/src/transitions.ts`) est la seule source ; après modification, lancer `pnpm gen:transitions` (la CI vérifie que le seed SQL est à jour).
- **Migrations additives seulement** (`db/shop/`, `db/registry/`) : on ajoute d'abord, on supprime deux versions plus tard. Une migration déjà publiée ne se modifie jamais.
- **Déploiement** : le Worker avant la version de l'app ; jamais `--allow-deletes` automatiquement ; en production `--no-release` puis `shopify app release` à la main.
- **Aucun nom de client ni de boutique réelle** dans le code, les tests, les fixtures ou les commits.
- Tests : `pnpm test` (Vitest ; `workers/` tourne dans workerd via `@cloudflare/vitest-plugin`). Vérification de types : `pnpm typecheck`.
