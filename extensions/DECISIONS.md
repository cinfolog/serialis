# Extensions admin : décisions et points ouverts

Périmètre : spec 13.5, 15.5, 15.6, 15.7, 9.15 (F15) et 19.4 (MVP). Cinq extensions `ui_extension`, API 2026-10,
Preact et composants web Polaris (`s-*`), un dossier par extension, code commun dans `extensions/shared`
(`@serialis/extensions-shared`).

| Dossier | Handle | Cible |
|---|---|---|
| `variant-block` | `serialis-variant-block` | `admin.product-variant-details.block.render` |
| `variant-action` | `serialis-variant-refs-action` | `admin.product-variant-details.action.render` |
| `product-block` | `serialis-product-block` | `admin.product-details.block.render` |
| `order-block` | `serialis-order-block` | `admin.order-details.block.render` |
| `order-action` | `serialis-order-units-action` | `admin.order-details.action.render` |

## Appel du backend (shopify.dev, « network features » et « connect app backend »)

- Un `fetch` relatif d'une extension admin est résolu contre `application_url`, et l'extension ajoute seule l'en-tête
  `Authorization` aux requêtes vers le domaine de l'app. Aucune capacité `network_access` n'est déclarée.
- **Le jeton est un jeton d'identité OpenID Connect (ID token)** en API 2026-10, pas le jeton de session d'App Bridge
  de l'app intégrée. Le Worker doit accepter ce jeton sur `/api/v1/*` (même clé de signature, `aud` = client_id).
- **CORS** : le Worker doit répondre aux requêtes (et au préalable `OPTIONS`) de l'origine `https://extensions.shopifycdn.com`,
  avec les en-têtes `Authorization, Content-Type, Idempotency-Key, If-Match, Accept, X-Serialis-Extension`.
- **Premier rendu signalé (15.4 « Démarrage », T-UX-08)** : le client commun envoie à chaque appel `X-Serialis-Extension` avec la cible
  Shopify de l'extension (`shopify.extension.target`, ou l'option `extensionTarget`) ; le Worker en déduit l'extension affichée
  (`EXTENSION_TARGETS` du contrat), quel que soit le premier appel. Avant, l'action commande n'était reconnue qu'à une écriture
  (sa lecture `GET /orders/{id}/allocations` marquait le bloc commande) et l'action variante jamais. Aucun fichier d'extension
  ne change : seul `extensions/shared/src/api-client.ts`.
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
  Les refs « déjà enregistrées » sont détectées pour la variante affichée, puis pour la boutique par la vérification serveur (décision 3) ; le lot reste le dernier garde-fou (`identifier_conflict`).
- **Clé d'idempotence (15.5)** : une clé par action, conservée tant que la charge utile est identique (nouvel essai après coupure),
  renouvelée après un succès ou un changement.
- **Chargement (15.7)** : spinner Polaris et « Encore un instant » après 3 s (pas de squelette : la liste des composants admin n'en propose pas).
  Bandeau « hors connexion » (`navigator.onLine`), validations bloquées, saisie conservée.
- **Bloc commande** : une ligne par unité (dans la limite de la décision 1), « À attribuer » pour les unités manquantes, historique (libérées, retournées) après les
  attributions actives ; actualisation automatique toutes les 3 s (20 fois au plus) tant que `syncState = 'pending'`
  (« attribution en cours »). Bouton « Modifier les unités » : `shopify.navigation.navigate('extension://serialis-order-units-action')`.
- **Action variante « Ajouter des refs »** : le formulaire d'ajout (décision 2). Les règles (emplacements proposés, type par défaut,
  plan d'ajout, requête et résultat du lot) sont dans `extensions/shared/src/variant.ts`, partagé avec le bloc variante.
- **Bloc variante** : les unités sont lues par pages de 250 (8 pages au plus) ; au-delà, un bandeau signale que les chiffres sont
  partiels. Les comptes par état sont calculés côté extension. La recherche de ref et la liste complète sont dans l'app
  (écran Unités filtré sur la variante), plus dans le bloc (décision 1).
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

## Décisions numérotées

### 1. Hauteur des blocs : contenu essentiel ≤ 300 px

Constat sur la boutique de développement : le bloc variante affichait l'avertissement « This Block is too tall » et était coupé
par « Show more » (bandeau d'initialisation, tableau à 5 colonnes, tableau des refs et formulaire d'ajout empilés).

Limites de Shopify (shopify.dev, `s-admin-block` et consignes de conception des blocs, vérifiées le 18/11/2026) : au-delà de
300 px, Shopify affiche un bouton « Show more » qu'on ne peut ni retirer ni désactiver ; une fois déplié, le bloc s'arrête à sa
hauteur maximale et le reste est coupé (le marchand voit alors un lien vers l'app) ; avertissements en console en développement ;
les consignes demandent d'éviter les blocs trop hauts (moins de 600 px) et de paginer si besoin ; `collapsedSummary` est tronqué
au-delà de 30 caractères. `s-modal` ne fait pas partie des composants des blocs (`BlockExtensionComponents` = composants standard,
`AdminBlock` et `Form`).

**Règle : le contenu essentiel d'un bloc tient dans 300 px** pour les cas courants, sans « Show more ».

- **Bloc variante** : une ligne par emplacement (« Entrepôt · Shopify 10 · 0 ref » et le badge d'écart) ; à partir de 3
  emplacements, un tableau de 4 colonnes limité à 3 lignes (emplacements en écart d'abord) et « +N autres emplacements ».
  Le bandeau d'initialisation devient une ligne de texte, affichée seulement tant que Shopify montre des unités à enregistrer.
  Les comptes par état sur une ligne, puis les 3 refs les plus récentes (aucune à côté du tableau des emplacements) ; le lien
  « Voir les N refs » ouvre `app:units?variant=<gid>`. « Ajouter des refs » reste le bouton principal et ouvre l'action
  variante (décision 2) ; l'arrêt du suivi passe dans le menu « Plus d'actions » et sa confirmation remplace la ligne d'actions.
- **Bloc produit** : une ligne par variante (titre en lien vers la variante, badge de suivi, disponibles, écart), 5 au plus
  (variantes suivies d'abord), puis « +N autres variantes » et un lien vers l'app.
- **Bloc commande** : 2 lignes suivies au plus (celles qui ont des unités à attribuer d'abord) et 4 lignes d'unités en tout
  (4 pour une ligne, 2 chacune pour deux) ; le reste est compté à côté de « Modifier les unités », qui montre toutes les unités.
- `collapsedSummary` sur les trois blocs : « 0 ref · 10 à enregistrer », « 1 variante suivie sur 2 », « 1 unité à attribuer ».
- **Vérification** : jsdom ne calcule pas de mise en page ; `estimateHeight` (`@serialis/extensions-shared/testing`) estime
  la hauteur à partir des composants rendus (ligne de texte 20 px, badge 22, bouton 32, titre 24, tableau 36 + 40 par ligne,
  piles additionnées avec leurs espacements, sans retour à la ligne). Les tests des trois blocs vérifient `≤ 300` sur les
  cas courants (variante en initialisation avec 1 ou 2 emplacements et 0 à 5 refs, 4 emplacements,
  produit à 12 variantes, commande de 18 unités). C'est un garde-fou contre l'empilement, pas une mesure : la hauteur réelle
  se contrôle dans l'admin (à 375 px de large, les lignes se replient).
- Taille des paquets après la refonte (esbuild, minifié) : bloc variante 35 Ko, produit 24 Ko, commande 25 Ko, sous la limite
  de 64 Ko des extensions d'interface Shopify (la CI ne construit pas les extensions).
- Hors du budget, assumé : bandeaux temporaires (hors connexion, attribution en cours, erreur), retour d'un ajout avec refs
  refusées, aperçu des lignes en erreur du collage.

### 2. Ajout de refs : action modale de la page variante, plus formulaire dans le bloc

Constat sur la boutique de développement après la décision 1 : l'étape « Ajouter des refs » qui remplaçait le résumé du bloc
variante restait trop haute (« This Block is too tall », « Show more ») : sélecteur d'emplacement pleine largeur même avec un seul
emplacement, choix « déjà comptées / reçues », champ des refs, puis les boutons sous la ligne de flottaison. Un formulaire de
saisie de nombreuses refs n'a pas sa place dans un bloc limité à 300 px.

- **Nouvelle extension `variant-action`** (handle `serialis-variant-refs-action`, cible `admin.product-variant-details.action.render`,
  vérifiée sur shopify.dev, liste des cibles de l'API 2026-10, le 18/11/2026) : Shopify l'affiche en fenêtre modale, et aussi
  dans le menu « Plus d'actions » de la page variante. La variante vient de `shopify.data.selected`.
- **Dans la fenêtre** : emplacement en une ligne (« Emplacement : Entrepôt ») s'il n'y en a qu'un, sélecteur à partir de 2
  (premier emplacement avec des unités à enregistrer) ; type « déjà comptées / reçues » (« déjà comptées » par défaut en
  initialisation ou quand Shopify montre un écart ; le défaut suit l'emplacement tant que la personne n'a pas choisi) ; champ de
  8 lignes, décompte en direct et lignes signalées (doublon, déjà connue, format invalide). Boutons dans les emplacements de
  `s-admin-action` : principal « Ajouter N refs », secondaire « Annuler ». Le principal ouvre la confirmation qui nomme l'effet
  exact (15.7 : « … le stock Shopify augmentera de N » ou « sans aucune écriture »), puis « Confirmer l'ajout de N refs » et
  « Retour ».
- **Après l'envoi** : comme l'action commande, la fenêtre reste ouverte et montre le résultat. Tout ajouté : bandeau de succès,
  principal « Fermer », secondaire « Ajouter d'autres refs ». Refs refusées : elles restent dans le champ avec leur motif
  (T-UX-02), le secondaire devient « Fermer ». Clé d'idempotence, erreurs et hors connexion inchangés (même code qu'avant, déplacé).
- **Bloc variante** : seulement le résumé compact. « Ajouter des refs » appelle
  `shopify.navigation.navigate('extension://serialis-variant-refs-action')`. Le bloc n'est pas prévenu de la fermeture de la
  fenêtre : après l'ouverture, il se recharge toutes les 4 s pendant 2 minutes, et tout de suite au retour de la visibilité ou du
  focus quand le bac à sable expose ces évènements (`useRefreshAfterAction`, `extensions/shared/src/hooks.ts`) ; le rechargement
  garde l'affichage, sans clignotement. Si `shopify.navigation` n'existe pas, le bouton devient un lien vers le formulaire
  d'ajout de l'app : `app:units?variant=<gid>&add=1` (écran Unités).
- **Langues** : les textes du formulaire passent de `variantBlock` à l'espace `variantAction`.
- **Vérification** : tests de l'action (un ou plusieurs emplacements, défaut d'initialisation, déjà comptées / reçues,
  doublons, confirmation, succès, refus partiel, erreur, nouvelle tentative avec la même clé, hors connexion) ; tests du bloc
  (le bouton navigue, aucun formulaire, rechargement après ouverture, lien de repli, budget de 300 px par `estimateHeight`).
- Taille des paquets (esbuild, minifié) : bloc variante 29 Ko, action variante 27 Ko.
- **À vérifier dans l'admin réel** : la fenêtre s'ouvre depuis le bloc ; le bloc se met à jour après la fermeture (sinon, noter
  le délai observé) ; l'action apparaît aussi dans « Plus d'actions » de la variante.

### 3. Action variante : refs déjà enregistrées et doublons signalés avant l'envoi

Demande du marchand (admin réel) : voir, dans la fenêtre « Ajouter des refs », les refs déjà enregistrées pour la variante.

- **Section « Refs déjà enregistrées »** sous le formulaire, visible aussi après un ajout. Titre avec le compte à
  l'emplacement choisi (« Déjà enregistrées à Entrepôt (12) ») ; une ligne « + N à d'autres emplacements » et un bouton
  « Voir tous les emplacements » (colonne Emplacement ajoutée, retour par « Seulement Entrepôt »). Une ligne par ref :
  ref, badge d'état (libellés et tons de `StateBadge`), date d'enregistrement (`createdAt`, `shopify.i18n.formatDate`).
  Toutes les refs de la variante, quel que soit l'état (vendues comprises) : c'est ce que le marchand ne peut plus
  réenregistrer. Aucune ref : une seule ligne « Aucune ref enregistrée pour l'instant ».
- **Lecture** : `GET /units?variant=&location=&limit=20`, puis « Afficher plus » avec `cursor` (ordre du serveur, par
  identifiant, donc d'enregistrement). Au-delà de 20 refs, champ de filtre : recherche par début de ref (`q`, recherche
  par préfixe du serveur), envoyée 300 ms après la dernière frappe. Les comptes viennent des unités déjà chargées pour le
  formulaire (`loadVariantData`, 8 pages de 250) ; affichés « N+ » si cette lecture est tronquée.
- **Repliable** : la liste des composants admin 2026-10 (`StandardComponents`) n'a ni `s-details` ni section repliable
  (`s-section` n'a que `heading`, `padding`) ; un bouton tertiaire « Masquer / Afficher » (`aria-expanded`) replie la
  section, dépliée à l'ouverture.
- **Doublons en direct** : (1) contre les unités de la variante déjà chargées, immédiatement ; (2) pour la boutique,
  `POST /units/batch/check` (même corps que le lot, n'écrit rien, applique la portée d'unicité S-35 et les règles de
  format S-37) 500 ms après la dernière frappe, avec seulement les refs que le client n'a pas déjà écartées ni déjà
  vérifiées (verdicts gardés pendant la vie de la fenêtre ; la portée ne dépend pas de l'emplacement). `already_known`
  → « Déjà enregistrée », `invalid_format` → « Format invalide » ; ces lignes sortent du décompte « Ajouter N refs ».
  L'emplacement et l'état d'une ref connue viennent de la liste chargée, sinon de `GET /lookup?identifier=` (5 au plus
  par vérification) : « Déjà enregistrée — autre variante · Boutique · Réservée ». La vérification est faite avec
  `alreadyCounted: false` (seul le doublon intéresse, l'écart est traité par le formulaire). Un échec de vérification ne
  signale rien : le lot reste le dernier garde-fou (`identifier_conflict` par ref). Chaque vérification lit le niveau de
  stock dans Shopify côté serveur : d'où l'attente après la frappe et le cache des verdicts, pas d'appel par touche.
- **Après un ajout** : les unités renvoyées par le lot (`created`) s'affichent en tête avec « nouvelle », la première page
  est relue et les comptes rechargés.
- **Bloc variante** inchangé (règle des 300 px, lien « Voir les N refs »). La fenêtre n'est pas soumise à cette limite.
- **Vérification** : tests de l'action (liste et compte, aucune ref, pages et curseur, filtre, autres emplacements et
  bascule, doublon signalé par le serveur avec emplacement et état, ref vérifiée une seule fois, échec de vérification,
  nouvelles refs en tête après l'ajout, anglais). Paquet de l'action : 33 Ko (esbuild, minifié), sous 64 Ko.
- **À vérifier dans l'admin réel** (recette 3.11) : délai du signalement d'un doublon ; rendu du bouton « Masquer » et du
  champ de filtre dans la fenêtre ; format de la date ; CORS de `POST /units/batch/check` et `GET /lookup` depuis
  l'extension (mêmes en-têtes que les autres routes).

### 4. Clés d'idempotence sans `crypto.randomUUID`

- **Constat (recette navigateur du 18/11)** : « Turn on tracking » échouait avec « An unexpected error occurred » sur toutes
  les variantes. Les journaux du Worker staging (Workers Observability) ne montrent **aucune** requête `POST /tracked-items`
  ni pré-vol `OPTIONS` correspondant, alors que les `GET` des mêmes extensions arrivent : l'échec se produit dans
  l'extension, avant l'envoi. Les `POST` venus de l'app (imports, clés d'API, arrêt d'urgence) passaient.
- **Cause** : la clé `Idempotency-Key` était tirée par `crypto.randomUUID()`, qui n'existe que dans un contexte sécurisé ;
  le bac à sable des extensions (Web Worker dans une iframe isolée) ne le garantit pas. L'appel levait `TypeError`, pris pour
  une erreur inconnue. Le test `zz-repro` (retiré après coup) reproduisait l'échec à coup sûr en masquant `randomUUID`.
- **Correctif** : `newUuid()` (`extensions/shared/src/uuid.ts`) utilise `randomUUID` s'il existe, sinon
  `crypto.getRandomValues` (disponible partout), sinon `Math.random` ; `IdempotencyKeeper` et le client d'API l'utilisent.
  Test : `idempotency.test.ts` (« falls back to getRandomValues… »).
- **Diagnostic** : une erreur qui n'est pas une réponse de l'API affiche désormais « … (TypeError: message) » après le texte
  générique, pour qu'une capture suffise à la diagnostiquer.

### 5. Bloc commande : état réel des unités, quantité, décompte et rafraîchissement (recette 2)

- **État réel** : une unité expédiée dont le retour est attendu affichait « Expédiée » ; le badge suit maintenant
  `unitState` (contrat, décision 81 de `workers/DECISIONS.md`) dès que l'unité est partie : « Retour attendu » (ton
  d'avertissement), puis, retour traité, l'état d'arrivée (« Disponible », « Mise au rebut »…). Avant expédition, le
  badge reste celui de l'attribution.
- **Quantité** : la ligne affichait « × 0 » après un retour (quantité courante Shopify). Elle affiche la quantité commandée
  (`orderedQuantity`), suivie de « N en attente de retour » et « N retournée(s) » s'il y a lieu.
- **Décompte** : « + N autres unités » comptait l'historique (attributions libérées) : « +10 » sur une ligne de 7 unités.
  Les attributions libérées ne sont plus ni affichées ni comptées dans le bloc (l'action « Modifier les unités » les
  garde) ; les unités retournées sont affichées après les unités présentes, sans entrer dans le décompte, qui ne porte
  que sur les unités présentes (attribuées ou expédiées) et les unités à attribuer.
- **Rafraîchissement** : le bloc restait périmé jusqu'au rechargement de la page après « Modifier les unités ». Il
  utilise `useRefreshAfterAction` comme le bloc variante (décision 2) : rechargement toutes les 4 s pendant 2 min après
  l'ouverture de l'action, et au retour de visibilité ou de focus.
- Tests : `order-block/test/logic.test.ts`, `OrderBlock.test.tsx` (« recette 2 — … »). Paquet du bloc : 27 Ko.
- **À vérifier dans l'admin réel** : délai de mise à jour après la fermeture de l'action ; rendu des deux textes de
  retour à côté de « × N ».

### 6. Action variante : emplacement proposé par défaut (recette 2)

- Constat : la fenêtre proposait « My Custom Location » au lieu de l'emplacement en écart. La règle prenait le premier
  emplacement en écart dans l'ordre de la liste de stock, sinon la première option.
- Règle : l'emplacement au plus grand écart positif (Shopify − refs enregistrées) ; sans écart, l'emplacement principal.
  `Location.isPrimary` est déprécié en API 2026-10 et n'est pas dans le contrat : l'emplacement principal est pris comme
  l'emplacement actif le plus ancien (identifiant numérique le plus petit ; Shopify crée d'abord l'emplacement par
  défaut), de préférence parmi ceux qui ont un niveau de stock pour la variante ; sinon la première option.
- Test : `shared/test/variant.test.ts` (« recette 2 — … »). **À vérifier dans l'admin réel** : sur une boutique dont
  l'emplacement principal a été changé après coup, la règle « plus ancien » peut proposer l'ancien ; le choix reste
  modifiable.

### 7. Bloc commande pendant un arrêt d'urgence

- `GET /orders/{id}/allocations` renvoie `automationPaused` (décision 77 de `workers/DECISIONS.md`). Quand il est vrai,
  une unité à attribuer affiche « Automatisation en pause (arrêt d'urgence) » au lieu de « En attente d'une unité » :
  la ligne attend la reprise, pas du stock. Test : `OrderBlock.test.tsx` (« emergency stop… »).

### 8. Bloc commande : rafraîchissement en arrière-plan et quantité courante (recette 3)

- **Constat** : après une expédition ou une modification de commande faite dans l'admin natif, le bloc ne changeait
  qu'après F5 (rien au bout de 35 à 50 s) : Shopify ne prévient pas le bloc.
- **Rafraîchissement** (`useLivePolling`, `extensions/shared/src/hooks.ts`) : tant que le document est visible, le bloc
  se recharge toutes les 10 s pendant les 10 premières minutes après son affichage, puis toutes les minutes ; rien ne
  part pendant que le document est masqué, et il se recharge aussitôt quand il redevient visible. La lecture est
  conditionnelle : le client garde la dernière réponse et son `ETag`, envoie `If-None-Match` et rend le même objet sur
  304 (décision 86 de `workers/DECISIONS.md`). Le rafraîchissement rapide « attribution en cours » (3 s, 20 fois) suit
  désormais le nombre de lectures (`useResource().loads`) et non l'objet reçu, qui ne change plus sur 304.
- **Quantité** : l'en-tête affichait « × 3 » après une modification 3 → 2 (quantité commandée, décision 5). Il affiche
  la quantité courante, puis la quantité commandée quand elle est différente : « × 2 (3 commandés) » / « × 2 (3 ordered) ».
  Une ligne vidée par son retour garde la quantité commandée à côté des unités retournées (jamais « × 0 », décision 5).
- Tests : `order-block/test/logic.test.ts`, `OrderBlock.test.tsx`, `shared/test/api-client.test.ts` (« recette 3 — … »).
  Paquet du bloc : 29 Ko.
- **À vérifier dans l'admin réel** : délai d'apparition d'une expédition faite dans l'admin (≤ 10 s plus le délai des
  webhooks) ; `visibilitychange` exposé par le bac à sable (sinon le bloc continue de se recharger au rythme lent).

### 9. Action « Ajouter des refs » : résumé fidèle au serveur et motifs lisibles (recette 3)

- **Constat** : (1) « 1 prête » restait affiché après le refus de la ref par le serveur ; (2) le nombre « déjà enregistrées »
  semblait passer de 50 à 51 pendant la saisie ; (3) les lignes refusées ou invalides étaient peu lisibles (badge et
  motif serrés dans une cellule de tableau, liste des refus répétée dans le bandeau).
- **Résumé** : les refs refusées par `POST /units/batch` sont gardées (ref normalisée → code et détail) et passées à
  `buildAddPlan` (`rejectedRefs`) : leur ligne prend le statut `rejected` (« Refusée »), sort de « prêtes » et du bouton
  « Ajouter N refs » tant qu'elle n'est pas modifiée ; une ligne changée redevient une nouvelle ref.
- **Compte des refs enregistrées** : il ne vient que des unités chargées (`loadVariantData`), jamais de la saisie. Le
  décompte en direct portait les mêmes mots (« N déjà enregistrée(s) ») sans dire qu'il compte les lignes saisies : il
  commence désormais par « Liste saisie : » / « Your list: ». Test : le titre « Déjà enregistrées à Entrepôt (3) » ne
  bouge pas pendant la saisie.
- **Une ligne par ref signalée** : ref en gras, badge du statut (critique pour refusée ou invalide), puis le motif
  (emplacement et état d'une ref connue, message traduit du refus du serveur avec son détail). Le bandeau de résultat
  ne garde que le nombre de refs ajoutées et refusées.
- Tests : `variant-action/test/VariantAction.test.tsx`, `shared/test/refs.test.ts`. Paquet de l'action : 36 Ko.
