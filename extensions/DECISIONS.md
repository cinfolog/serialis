# Extensions admin : décisions et points ouverts

Périmètre : spec 13.5, 15.5, 15.6, 15.7, 9.15 (F15) et 19.4 (MVP). Quatre extensions `ui_extension`, API 2026-10,
Preact et composants web Polaris (`s-*`), un dossier par extension, code commun dans `extensions/shared`
(`@serialis/extensions-shared`).

| Dossier | Handle | Cible |
|---|---|---|
| `variant-block` | `serialis-variant-block` | `admin.product-variant-details.block.render` |
| `product-block` | `serialis-product-block` | `admin.product-details.block.render` |
| `order-block` | `serialis-order-block` | `admin.order-details.block.render` |
| `order-action` | `serialis-order-units-action` | `admin.order-details.action.render` |

## Appel du backend (shopify.dev, « network features » et « connect app backend »)

- Un `fetch` relatif d'une extension admin est résolu contre `application_url`, et l'extension ajoute seule l'en-tête
  `Authorization` aux requêtes vers le domaine de l'app. Aucune capacité `network_access` n'est déclarée.
- **Le jeton est un jeton d'identité OpenID Connect (ID token)** en API 2026-10, pas le jeton de session d'App Bridge
  de l'app intégrée. Le Worker doit accepter ce jeton sur `/api/v1/*` (même clé de signature, `aud` = client_id).
- **CORS** : le Worker doit répondre aux requêtes (et au préalable `OPTIONS`) de l'origine `https://extensions.shopifycdn.com`,
  avec les en-têtes `Authorization, Content-Type, Idempotency-Key, If-Match, Accept`.
- L'identifiant de commande dans la route est **numérique** (`GET /orders/{id}/allocations`, comme `order_id` de l'API publique,
  spec 9.15 point 3), extrait du GID `gid://shopify/Order/{id}`.

## Choix

- **Langues (15.9)** : `locales/fr.default.json` (français par défaut) et `locales/en.json` dans chaque extension, générés
  par `pnpm --filter @serialis/extensions-shared sync-locales` depuis `extensions/shared/locales/{fr,en}.json`
  (source unique ; Shopify n'empaquette que le dossier de l'extension). Un test vérifie que les fichiers générés sont à jour,
  que FR et EN ont les mêmes clés, que les pluriels définissent toutes les formes CLDR et que chaque clé utilisée dans le code existe.
  Écart avec 15.9 (« format ICU ») : `i18n.translate` de Shopify utilise `{{variable}}` et des objets de pluriel, pas ICU.
- **Désignation (15.5)** : `resolveDesignation` accepte la ref en entier ou ses 4 derniers caractères s'ils sont uniques parmi les
  unités proposées ; l'autocomplétion (dès 3 caractères) remplit seulement le champ ; Entrée ne valide qu'une ref saisie qui désigne
  une unité (entière ou 4 derniers caractères), jamais une suggestion. La normalisation côté client applique les valeurs par défaut de S-36
  (espaces retirés, majuscules) ; le serveur reste l'autorité. L'action « Modifier les unités » autorise aussi le choix dans la liste
  (attribution et remplacement avant préparation : aucune unité physique en jeu, 15.5).
- **Unités proposées pour attribuer** : unités `AVAILABLE` de la variante (`GET /units?variant=&state=AVAILABLE`), toutes
  localisations, premier entré premier sorti (défaut de S-05) avec leur emplacement ; le contrat n'expose pas l'emplacement de
  l'ordre d'expédition d'une ligne, donc un `location_mismatch` éventuel vient du serveur et s'affiche en clair.
  Liste limitée à 4 pages de 250 ; si elle est tronquée, une ref saisie qui ne correspond à rien est envoyée telle quelle (`ref`) au serveur.
- **Effet annoncé avant confirmation (15.7)** : attribuer, remplacer et retirer n'écrivent pas dans le stock Shopify (transitions ALLOCATED ↔ AVAILABLE, sans écriture de stock) ; l'ajout de refs « reçues » annonce « stock Shopify +n », « déjà comptées » annonce « aucune écriture » et est refusé
  dans l'extension quand l'écart Shopify est nul (message de 15.7), mais seulement signalé quand il dépasse l'écart (le serveur tranche).
- **Ajout de refs** : `mode: 'per_item'` (T-UX-02 : les 47 valides sont créées, les 3 en erreur restent dans le champ avec leur motif).
  Format côté client : 128 caractères au plus, pas de caractère de contrôle (S-37 reste côté serveur). 1 000 refs au plus par envoi.
  Les refs « déjà connues » ne sont détectées que pour la variante affichée ; les autres conflits reviennent en `identifier_conflict`.
- **Clé d'idempotence (15.5)** : une clé par action, conservée tant que la charge utile est identique (nouvel essai après coupure),
  renouvelée après un succès ou un changement.
- **Chargement (15.7)** : spinner Polaris et « Encore un instant » après 3 s (pas de squelette : la liste des composants admin n'en propose pas).
  Bandeau « hors connexion » (`navigator.onLine`), validations bloquées, saisie conservée.
- **Bloc commande** : une ligne par unité, « À attribuer » pour les unités manquantes, historique (libérées, retournées) après les
  attributions actives ; actualisation automatique toutes les 3 s (20 fois au plus) tant que `syncState = 'pending'`
  (« attribution en cours »). Bouton « Modifier les unités » : `shopify.navigation.navigate('extension://serialis-order-units-action')`.
- **Bloc variante** : les unités sont lues par pages de 250 (8 pages au plus) ; au-delà, un bandeau signale que les chiffres sont
  partiels et renvoie vers l'app. Les comptes par état sont calculés côté extension.
- **Lien vers la variante (bloc produit)** : `shopify:admin/products/{id}/variants/{id}` dans `<s-link href>` ; le format n'est pas
  détaillé dans la référence des composants, à vérifier sur la boutique de développement.
- **`exactOptionalPropertyTypes` désactivé** dans `extensions/tsconfig.ext.json` (les types de propriétés des composants Polaris
  ne le supportent pas) ; le reste de `tsconfig.base.json` est conservé.
- **`uid` des extensions** : non commité, le CLI le génère au premier `shopify app deploy`.

## Ajouts au contrat (`api/contract`, à la fin du fichier, rien de modifié)

- `ListTrackedItemsQuery` : filtres optionnels `variant` et `product` de `GET /tracked-items` (blocs variante et produit).
- `UntrackItemsRequest` : `POST /tracked-items` avec `action: 'untrack'` (arrêt du suivi, EF-01) ; sans `action`, c'est `TrackItemsRequest`.
- `TrackItemsResponse = Page<TrackedItem>` et `ListLocationsResponse = Page<Location>` : formes de réponse précisées.

## Hors périmètre ou non fourni par le contrat

- **Carte de démarrage (15.6, T-UX-08)** : le signalement du premier affichage (table `extension_renders` du modèle de données) n'a pas de route dans le contrat ; non implémenté.
- **Sortie d'une ref avec motif (15.6, 19.4)** et **anomalies de la commande**, **lien vers la fiche unité** (bloc commande) : pas de route dans le contrat ; non implémentés.
- Déclarer endommagée ou introuvable, confirmer ou corriger une expédition, identifier un retour : lots suivants (15.6).
- Droits (15.8) : l'arrêt du suivi est une action d'administration ; un `forbidden` du serveur s'affiche en clair.
