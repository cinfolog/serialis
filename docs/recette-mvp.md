# Recette du MVP sur la boutique de développement

Liste de contrôle à dérouler à la main, dans le vrai admin Shopify de `serialis-test.myshopify.com`, avec l'app **Serialis** de l'environnement staging (`shopify.app.dev.toml`, `https://staging.serialis.dev`). Elle couvre les critères de sortie du MVP (spec 19.4) qui demandent une vraie boutique, les portes PV-3, PV-14, PV-19, PV-23, PV-24 et PV-29, et les contrôles notés « à vérifier dans l'admin réel » ou « vrai CDN Polaris » dans `README.md`, `app/DECISIONS.md` et `extensions/DECISIONS.md`.

Les tests automatiques (Vitest, workerd avec le simulateur, Playwright) couvrent déjà le reste des critères : ce document ne les rejoue pas.

## Mode d'emploi

- Une étape = une action courte, un résultat attendu, le critère couvert, une case à cocher.
- Cocher `☐` → `☑` quand le résultat est conforme. Sinon : noter l'écart dans la colonne, faire une capture, et ouvrir un ticket qui cite le numéro de l'étape.
- « App » = l'app Serialis ouverte dans l'admin (Applications › Serialis). « Bloc variante », « bloc produit », « bloc commande » = les blocs Serialis des pages correspondantes de l'admin.
- Les délais indiqués sont des maximums : la plupart des effets sont visibles en quelques secondes.
- Journaux du Worker pendant la recette (dans un terminal à part) :
  ```sh
  pnpm exec wrangler tail --env staging --format pretty
  ```
- Une PV n'est **levée** que si toutes ses étapes sont cochées ; reporter le résultat dans la spec (tableau des PV, section 11) et dans `workers/DECISIONS.md`.

## 0. Prérequis

### 0.1 Secrets et déploiement

| # | Action | Résultat attendu | Couvre | ☐ |
|---|---|---|---|---|
| 0.1.1 | Générer la clé de chiffrement des jetons et la poser dans l'environnement GitHub `staging` : `openssl rand -base64 32 \| gh secret set TOKEN_ENCRYPTION_KEY --env staging --repo cinfolog/serialis`. **Si le secret existe déjà et a servi**, ne pas l'écraser : poser `2:<nouvelle>,1:<ancienne>` (rotation, `workers/DECISIONS.md` 5). | `gh secret list --env staging --repo cinfolog/serialis` liste `TOKEN_ENCRYPTION_KEY`. Un secret de dépôt convient aussi (le job `deploy` tourne dans l'environnement `staging`, qui hérite des secrets du dépôt) ; le déploiement le confirme : plus d'avertissement « secret staging: … missing » dans ses annotations. | 16, README « Secrets » | ☐ |
| 0.1.2 | Même chose pour le scellement des clés d'API : `openssl rand -base64 32 \| gh secret set API_KEY_SEAL_SECRET_V1 --env staging --repo cinfolog/serialis`. | Secret listé. | 14.1, `workers/DECISIONS.md` 48 | ☐ |
| 0.1.3 | Vérifier que `SHOPIFY_API_SECRET`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` et `SHOPIFY_CLI_TOKEN` sont présents dans le même environnement. | Les 4 sont listés. | README | ☐ |
| 0.1.4 | GitHub › Actions › **Deploy** › *Run workflow* › environnement `staging`. | Toutes les étapes vertes : tests, migrations D1, Worker, secrets, test de fumée, puis `shopify app deploy` (pas d'avertissement « SHOPIFY_CLI_TOKEN manquant »). | README « Déploiement » | ☐ |
| 0.1.5 | `curl -s https://staging.serialis.dev/healthz` | Réponse 200. | test de fumée | ☐ |
| 0.1.6 | Dev Dashboard › app Serialis › Versions. | Une nouvelle version contient les 5 extensions (bloc variante, action « Ajouter des refs », bloc produit, bloc commande, action « Modifier les unités »). | 19.4 écrans et extensions | ☐ |

### 0.2 Boutique et données de test

| # | Action | Résultat attendu | Couvre | ☐ |
|---|---|---|---|---|
| 0.2.1 | Paramètres › Emplacements : avoir deux emplacements actifs, notés **A** et **B** dans la suite. | Deux emplacements qui expédient. | T-MVP-01, T-MVP-03 | ☐ |
| 0.2.2 | Produits › Ajouter : « Vélo recette » avec deux variantes **M** et **L**, suivi du stock activé, stock 0 partout. Produit « Antivol recette » (non suivi par Serialis), stock 20 en A. | Produits créés, visibles sur la boutique en ligne. | T-MVP-07 | ☐ |
| 0.2.3 | Paramètres › Utilisateurs : avoir un second compte collaborateur (accès à l'app Serialis) pour les contrôles de droits. | Compte créé, invitation acceptée. | 15.8 | ☐ |
| 0.2.4 | Préparer un client test et un moyen de paiement test (Bogus Gateway ou paiements test Shopify). | Une commande test peut être passée sur la boutique en ligne. | T-MVP-02 | ☐ |

### 0.3 Installation et première ouverture

| # | Action | Résultat attendu | Couvre | ☐ |
|---|---|---|---|---|
| 0.3.1 | Si l'app est déjà installée et que 0.1.1 a remplacé une clé : ouvrir l'app une fois. Sinon, Dev Dashboard › Serialis › *Install app* › `serialis-test`, accepter les accès. | L'app s'ouvre dans l'iframe de l'admin, sans écran blanc ni erreur 401. | 9.14, PV-9 | ☐ |
| 0.3.2 | Ouvrir l'app **avec votre compte** avant le second compte (le premier utilisateur vu devient propriétaire et administrateur, `workers/DECISIONS.md` 57). Réglages. | Les réglages sont modifiables et la section « Clés d'API » propose la création : vous êtes administrateur. | 15.8 | ☐ |
| 0.3.3 | Recharger l'admin (F5) sur une page de l'app. | Session conservée, aucune nouvelle demande d'accès. | 13.9 | ☐ |
| 0.3.4 | Réglages › Santé › « Voir la santé de Serialis ». | « Tout fonctionne », accès à Shopify « Valide », boutique « Active », passes R1 à R4 et nettoyage programmés. | 17.1 | ☐ |

## 1. Admin réel : App Bridge, navigation, composants Polaris

À faire une fois, en début de recette ; tout écart ici fausse le reste.

| # | Action | Résultat attendu | Couvre | ☐ |
|---|---|---|---|---|
| 1.1 | Regarder le menu de gauche de l'admin sous « Serialis ». | Liens Accueil, Unités, Articles suivis, Anomalies, Imports, Réglages (`s-app-nav`) ; la barre de liens de secours du mode mock n'apparaît **pas**. | `app/DECISIONS.md` 21 | ☐ |
| 1.2 | Cliquer chaque lien du menu, puis le bouton Précédent du navigateur. | Chaque écran s'ouvre sans recharger l'iframe ; l'URL de l'admin suit ; Précédent revient à l'écran d'avant (`shopify:navigate`). | 19 et 21 | ☐ |
| 1.3 | Sur chaque écran, appuyer sur Tab une fois. | Le lien d'évitement apparaît, Entrée amène le focus dans la zone principale. | 15.9 | ☐ |
| 1.4 | Réglages : modifier un choix (ex. S-08) sans enregistrer. | La barre d'enregistrement apparaît (dans la page, décision 20) ; « Annuler » rétablit la valeur. Noter si Shopify affiche aussi sa propre barre contextuelle (doublon à corriger). | `app/DECISIONS.md` 20 | ☐ |
| 1.5 | Réglages : changer un champ texte, une liste, une case (S-22, S-05, S-36). | La valeur saisie est prise en compte à chaque fois (événements `input`/`change` de `s-text-field`, `s-select`, `s-checkbox`). | `app/DECISIONS.md` 19 | ☐ |
| 1.6 | Ouvrir une confirmation (ex. Réglages › Sécurité et exploitation › « Activer l'arrêt d'urgence »), puis Échap. Avec VoiceOver ou NVDA, écouter l'annonce. | Le dialogue s'ouvre avec fond grisé, le focus reste dedans, Échap ferme sans rien faire ; le lecteur d'écran annonce **un seul** dialogue nommé (sinon retirer `role="dialog"` côté app). | `app/DECISIONS.md` 19, 25 | ☐ |
| 1.7 | Articles suivis › « Suivre des articles ». | Le sélecteur de variantes de Shopify (resource picker) s'ouvre et liste les variantes de la boutique. | `app/DECISIONS.md` 10 | ☐ |
| 1.8 | Depuis l'app, cliquer un lien vers une commande ou un produit (`shopify:admin/...`). | La page Shopify correspondante s'ouvre dans l'admin, pas dans l'iframe ni dans un nouvel onglet vide. | `app/DECISIONS.md` 7, 9 | ☐ |
| 1.9 | Ouvrir l'app dans l'application mobile Shopify (iPhone). | Écrans lisibles, aucun défilement horizontal. | 15.9, T-UX-05 | ☐ |

## 2. Assistant de démarrage et blocs admin

| # | Action | Résultat attendu | Couvre | ☐ |
|---|---|---|---|---|
| 2.1 | Accueil : carte de démarrage › ouvrir l'assistant. | Étapes : choix des produits, refs existantes, écart avec Shopify, activation des blocs. | 19.4 écrans | ☐ |
| 2.2 | Étape « blocs » : suivre le lien vers une fiche produit. Sur la fiche, menu des blocs d'app › ajouter et **épingler** « Refs Serialis ». Idem sur une variante et sur une commande. | Les trois blocs s'affichent. Noter si un lien direct d'épinglage existe (à reprendre dans l'assistant). | `app/DECISIONS.md` 7 | ☐ |
| 2.3 | Sur une commande : menu « Plus d'actions » › « Modifier les unités ». | L'action s'ouvre en fenêtre. | 19.4 | ☐ |
| 2.4 | Revenir à l'assistant. | Chaque extension affichée est cochée ; l'assistant passe à « terminé » une fois les quatre vues (T-UX-08). | `app/DECISIONS.md` 7 | ☐ |

## 3. Refs depuis la variante et le produit (capacité 2)

| # | Action | Résultat attendu | Couvre | ☐ |
|---|---|---|---|---|
| 3.1 | Fiche « Vélo recette » › variante M › bloc « Refs Serialis » › « Suivre les refs » › confirmer. | Confirmation qui annonce « aucune écriture » ; la variante devient suivie, phase d'initialisation affichée. | EF-01, 15.7 | ☐ |
| 3.2 | Bloc variante M › « Ajouter des refs » : la fenêtre « Ajouter des refs » s'ouvre (le bloc garde son résumé, sans « Show more »). Emplacement A (liste déroulante seulement s'il y a 2 emplacements ou plus, sinon une ligne « Emplacement : … ») › « Reçues maintenant » › coller 50 refs `VR-M-A-001` à `VR-M-A-050` (une par ligne) › « Ajouter 50 refs » › « Confirmer l'ajout de 50 refs » › « Fermer ». | Décompte en direct « 50 prête(s) » ; effet annoncé « 50 unités … stock Shopify augmentera de 50 » ; « 50 refs ajoutées » ; après la fermeture, le bloc affiche les nouvelles refs en quelques secondes sans recharger la page ; stock Shopify de M en A = 50 sous 60 s (Produits › Stock). | T-MVP-01, `extensions/DECISIONS.md` 2 | ☐ |
| 3.3 | Fenêtre « Ajouter des refs » (depuis le bloc ou le menu « Plus d'actions » de la variante) : recommencer avec la même liste plus `VR-M-A-051`, une ligne `mauvaise ref!` et un doublon dans la liste. | Résumé avant envoi : doublon, déjà connues, format invalide ; seule `VR-M-A-051` est créée ; stock +1. | T-MVP-01, T-UX-02 | ☐ |
| 3.4 | Produits › Stock : passer M en B à 5 à la main. Bloc variante › « Ajouter des refs » › emplacement B › « Déjà comptées » (proposé par défaut) › 7 refs `VR-M-B-001…007`. | Avertissement « vous ajoutez 7 refs pour un écart de 5 » ; 5 créées, 2 refusées et laissées dans le champ avec leur motif ; **aucune** écriture de stock (B reste à 5). | T-MVP-01, 7.2 | ☐ |
| 3.5 | Fenêtre « Ajouter des refs » de M, avec écart nul en B : « Déjà comptées » › 1 ref. | Refus dans la fenêtre, bouton « Ajouter » désactivé : « Aucun écart dans Shopify : utilisez « Reçues » ». | 15.7 | ☐ |
| 3.6 | Bloc variante : tableau « Par emplacement ». | A : Shopify 51, refs 51, « Aligné » ; B : 5 / 5 « Aligné ». | 8, 15.6 | ☐ |
| 3.7 | Tout faire 3.2 au clavier seulement (Tab, Entrée, Échap). | Même résultat ; focus visible partout ; Échap ferme la fenêtre sans écrire. | T-UX-02 (action variante), 15.9 | ☐ |
| 3.8 | Fenêtre « Ajouter des refs » : couper le Wi-Fi pendant un ajout, puis le rétablir et valider de nouveau. | Bandeau « Hors connexion », saisie conservée ; au retour, l'ajout n'est appliqué qu'une fois (stock +n une seule fois). | T-UX-02, 15.5 | ☐ |
| 3.9 | Fiche produit › bloc produit. | « 1 variante suivie sur 2 », unités disponibles et écart par variante ; le lien « Voir la variante » ouvre la bonne variante (format `shopify:admin/products/{id}/variants/{id}` à confirmer). | 15.6, `extensions/DECISIONS.md` | ☐ |
| 3.10 | App › Imports : coller `ref,sku,location,already_counted` puis 3 lignes pour la variante L (SKU de L, emplacement A, `non`) et une ligne avec un emplacement inconnu › Simuler › Confirmer. | Rapport de simulation : 3 valides, 1 en erreur ; confirmation qui nomme l'effet ; 3 unités créées, stock L en A +3. | 19.4 capacité 2, 9.10 | ☐ |

## 4. Refs par l'API (capacité 1)

Base : `BASE=https://staging.serialis.dev/public/v1` (`workers/DECISIONS.md` 46). Remplacer `$KEY` par la clé créée en 4.1, `<M>`, `<L>` par les identifiants numériques des variantes, `<A>`, `<B>` par le champ `id` des emplacements renvoyé en 4.3, tel quel.

| # | Action | Résultat attendu | Couvre | ☐ |
|---|---|---|---|---|
| 4.1 | App › Réglages › Clés d'API › nom « Recette », portées par défaut + `allocations:read` › « Créer la clé » › copier › « J'ai copié la clé ». | La clé complète est montrée une seule fois, puis seulement son début dans la liste. | 14.1, O5 | ☐ |
| 4.2 | `curl -s $BASE/openapi.json \| head -c 300` | Document OpenAPI 3.1 ; aucune route `/health`, `/api-keys`, `/me` ni `/app-users`. | 14.1, `workers/DECISIONS.md` 56, 69 | ☐ |
| 4.3 | `curl -s -H "Authorization: Bearer $KEY" $BASE/locations` | Les emplacements A et B, avec leurs identifiants. | T-API-01 | ☐ |
| 4.4 | Créer une ref : `curl -s -X POST -H "Authorization: Bearer $KEY" -H "Idempotency-Key: r-1" -H "Content-Type: application/json" -d '{"variantGid":"gid://shopify/ProductVariant/<M>","locationId":"<A>","ref":"API-001","alreadyCounted":false}' $BASE/units` puis relancer **la même** commande. | 201 avec l'unité et un `ETag` ; le second appel rejoue la réponse (`Idempotent-Replayed: true`) ; stock +1 une seule fois. | T-MVP-01, T-API-01 | ☐ |
| 4.5 | Lot de 1 000 : générer `python3 -c "import json;print(json.dumps({'variantGid':'gid://shopify/ProductVariant/<L>','locationId':'<B>','refs':[f'API-L-{i:04d}' for i in range(1000)],'alreadyCounted':False,'mode':'atomic'}))" > lot.json` puis `POST $BASE/units/batch` avec `-d @lot.json`. | 1 000 unités créées ; stock L en B = 1 000 sous quelques minutes ; aucune ligne d'écriture en attente dans la santé après coup. | T-MVP-01 (lots de 1 000) | ☐ |
| 4.6 | Le même lot avec une ref déjà connue, mode `atomic`. | Refus complet, la ligne en cause est citée (`identifier_conflict`, index) ; rien créé. | T-MVP-01 | ☐ |
| 4.7 | `GET $BASE/lookup?identifier=API-001` puis `GET $BASE/units/<id>/events`. | L'unité et son historique (création par la clé `api_key`). | 19.4 capacité 1 | ☐ |
| 4.8 | Révoquer la clé dans l'app, rejouer 4.3. | 401 `api_key_revoked` immédiatement. | 14.1 | ☐ |

## 5. Attribution à la commande (capacités 4 et 5)

| # | Action | Résultat attendu | Couvre | ☐ |
|---|---|---|---|---|
| 5.1 | Boutique en ligne : commander 3 × « Vélo recette M » + 1 × « Antivol recette ». | Paiement normal, sans délai visible. | T-MVP-02, 19.4 | ☐ |
| 5.2 | Ouvrir la commande dans l'admin, bloc commande. | Sous 60 s : 3 refs distinctes de l'emplacement de l'ordre d'expédition, une ligne par unité ; « 1 autre ligne n'est pas suivie ». | T-MVP-02, T-MVP-07, F15 | ☐ |
| 5.3 | Commande › Metafields (ou `GET $BASE/orders/<id>/allocations`). | `serialis.units` liste les 3 refs pour la ligne ; aucune propriété de ligne ajoutée ; ligne Antivol intacte. | T-MVP-02, 13.4 | ☐ |
| 5.4 | Créer une commande dans l'admin (Commandes › Créer), et une commande par paiement accéléré depuis la fiche produit (Shop Pay / bouton « Acheter maintenant »). | Mêmes résultats que 5.2 pour chacune. | T-MVP-04 | ☐ |
| 5.5 | Commande sur un emplacement où M n'a plus d'unité libre (ou plus de quantité que d'unités). | Unités disponibles attribuées, `insufficient_units` (ou `awaiting_unit`) ouverte ; **aucune** mise en attente posée sur l'ordre d'expédition. | T-MVP-04, T-MVP-08 | ☐ |
| 5.6 | Ajouter ensuite une unité « Reçue » au bon emplacement depuis le bloc variante (fenêtre « Ajouter des refs »). | L'unité est attribuée à la ligne en attente, l'anomalie se ferme. | T-MVP-04, T-MVP-08 | ☐ |
| 5.7 | Accueil de l'app. | Part des lignes attribuées en moins de 60 s affichée et proche de 100 % ; anomalies listées. | 19.4 critères de réussite | ☐ |

## 6. Bloc commande et « Modifier les unités » (capacité 3)

| # | Action | Résultat attendu | Couvre | ☐ |
|---|---|---|---|---|
| 6.1 | Commande de 5.1 › « Modifier les unités » › ligne M › « Remplacer » › choisir une autre unité dans la liste › confirmer. | Effet annoncé « aucune écriture de stock » ; bloc commande, metafield et API à jour à la synchronisation suivante. | T-MVP-03, T-MVP-06 | ☐ |
| 6.2 | Même écran › « Retirer » une unité › confirmer. | La ligne reprend une autre unité libre (l'unité retirée est verrouillée 15 min), ou ouvre `awaiting_unit`. | T-MVP-06, `workers/DECISIONS.md` 25 | ☐ |
| 6.3 | Désigner par saisie : taper les 4 derniers caractères d'une ref, puis Entrée sur une suggestion. | Entrée sur une suggestion ne valide rien ; la ref entière (ou 4 derniers caractères uniques) valide. | 15.5, T-UX-07 | ☐ |
| 6.4 | Commande dont les lignes partent de A et de B (variante M en A, L en B). | Unités prises dans chaque emplacement. | T-MVP-03 | ☐ |
| 6.5 | Imprimer le bon de préparation de la commande. | Les refs attribuées y figurent (si le modèle les affiche ; sinon noter l'écart pour la doc marchand). | T-MVP-03, L8 | ☐ |
| 6.6 | Collaborateur (second compte, ouvert après le vôtre, donc opérateur) : ouvrir le bloc commande et remplacer une unité. | Autorisé ; dans l'app, les réglages et l'écran Santé sont en lecture seule. | 15.8 | ☐ |

## 7. Expéditions et changements d'ordres d'expédition

| # | Action | Résultat attendu | Couvre | ☐ |
|---|---|---|---|---|
| 7.1 | Commande de 3 unités attribuées : expédier 2 articles sur 3. | `shipped_unit_to_confirm` ; Anomalies › désigner les 2 unités parties par saisie ; historique corrigé ; aucune écriture de stock. | T-MVP-10 | ☐ |
| 7.2 | Commande d'une variante suivie sans unité libre : l'expédier quand même. | `shipped_without_unit` ; désignation par saisie (AVAILABLE → SHIPPED, source « a posteriori ») ; aucune mutation de mise en attente dans les journaux. | T-MVP-08 | ☐ |
| 7.3 | **PV-23** — Commande avec unités attribuées : changer l'emplacement de l'ordre d'expédition (« Modifier l'emplacement » de A vers B), puis scinder un ordre (expédier une partie depuis un autre emplacement). Noter l'heure. | Sous 15 min, l'attribution suit le nouvel emplacement. Dans `wrangler tail`, la synchronisation vient de R1 (`reconcile.r1` qui programme la commande) : **PV-23 levée** si R1 l'a vue (`Order.updatedAt` mis à jour) ; si seule R2 la rattrape, noter « repli R2 ». | PV-23, 12.5 | ☐ |
| 7.4 | Vente en caisse (Shopify POS) d'un article suivi, si un POS de test est disponible. | `pos_sold_without_unit` en avertissement ; désignation depuis le bloc commande. | T-MVP-08 | ☐ |

## 8. Modifications, annulations et suppressions

| # | Action | Résultat attendu | Couvre | ☐ |
|---|---|---|---|---|
| 8.1 | Commande de 3 unités : Modifier la commande › quantité 3 → 2 › **cocher** « Remettre en stock ». | L'unité libérée est la dernière attribuée ; elle repasse disponible. | T-MVP-03, PV-14 | ☐ |
| 8.2 | **PV-14** — Même opération en **décochant** « Remettre en stock ». Puis ouvrir l'historique de la commande. | Avec drapeau `restock` lisible dans `orders/edited` : unité « Perdue »/sortie selon la remise ; sans drapeau : unité « À vérifier » (repli). Noter dans `wrangler tail` le contenu du webhook (`order_edit` et présence de `restock`) : **PV-14 levée** si l'indication est présente dans les deux cas. | PV-14, 9.3 | ☐ |
| 8.3 | Annuler une commande non expédiée avec remise en stock. | Unités libérées, disponibles ; stock Shopify inchangé par l'app (Shopify remet le stock). | T-MVP-06 | ☐ |
| 8.4 | **PV-24** — Créer une commande (admin), puis la **supprimer** (commande archivée › Supprimer, ou commande test). Relever le stock avant et après. | Unités libérées. Si Shopify a remis le stock seul : aucune écriture de l'app ; sinon écriture corrective de l'app (journal `outbox`). Noter lequel des deux. | PV-24 | ☐ |
| 8.5 | **PV-24 (suite)** — Variante à `available` = 0 : déclarer une unité perdue ou sortie qui exige un ajustement négatif. | Shopify accepte l'ajustement (pas d'erreur dans les journaux, pas d'écriture `dead`), ou refus noté. **PV-24 levée** si 8.4 et 8.5 sont conformes. | PV-24 | ☐ |

## 9. Retours

| # | Action | Résultat attendu | Couvre | ☐ |
|---|---|---|---|---|
| 9.1 | Commande expédiée d'1 unité : Retour › créer, recevoir, disposition « Remettre en stock ». | L'unité attend l'identification (S-17 = oui) ; Anomalies › `return_unidentified` › saisir la ref (entière ou 4 derniers caractères) › disposition appliquée : unité disponible. | T-MVP-06, 15.5 | ☐ |
| 9.2 | Même parcours sur une ligne de 2 unités, en saisissant une ref d'une **autre** unité. | `return_unit_mismatch`, aucune écriture. | T-MVP-06 | ☐ |
| 9.3 | **PV-3** — Retour avec disposition « Contrôle requis » (processing required). Relever `available` et `quality_control` (Produits › Stock › détail des quantités) avant et après. | Unité en « Contrôle qualité ». Si Shopify **n'ajoute rien** à `available` : l'app écrit `quality_control` +1 (branche par défaut, aucun changement). Si Shopify ajoute à `available` : noter l'écart, la branche `processingRequiredAddsAvailable` doit être activée (`core/DECISIONS.md`). **PV-3 levée** avec le comportement constaté. | PV-3, 7.2 | ☐ |
| 9.4 | Disposition « Ne pas remettre en stock ». | Unité mise au rebut, aucune écriture de stock. | 7.2 | ☐ |
| 9.5 | **PV-19** — Faire un échange (retour d'une ligne + article d'échange) depuis l'admin. Dans `wrangler tail`, relever les sujets reçus (`returns/*`, `reverse_fulfillment_orders/dispose`, `orders/updated`…) au moment de la disposition et du `returnProcess`. | Ligne d'échange traitée comme une ligne de commande (unité attribuée) ; retour identifié comme en 9.1. Noter la liste exacte des sujets émis. | PV-19 | ☐ |
| 9.6 | **PV-19 (suite)** — Retour fait en caisse (POS), si disponible. | L'emplacement de vente se lit sur le retour ou la ligne d'échange ; sinon le retour est rattrapé par R1 en 15 min au pire et identifié depuis les anomalies. **PV-19 levée** avec 9.5 et 9.6. | PV-19 | ☐ |

## 10. Écarts de stock

| # | Action | Résultat attendu | Couvre | ☐ |
|---|---|---|---|---|
| 10.1 | Produits › Stock : retirer 2 unités de M en A à la main. | Sous 60 min (en pratique quelques secondes après le délai de grâce S-22) : `stock_mismatch_missing_units` ou `stock_mismatch_extra_units` ; **aucune** correction automatique. | T-MVP-09 | ☐ |
| 10.2 | Remettre le stock à sa valeur. | L'anomalie se ferme au contrôle suivant. | 8 | ☐ |
| 10.3 | Catalogue mixte : modifier le stock de « Antivol recette ». | Aucune anomalie, rien dans les journaux pour cette variante. | T-MVP-07 | ☐ |

## 11. Réglages, droits et arrêt d'urgence

| # | Action | Résultat attendu | Couvre | ☐ |
|---|---|---|---|---|
| 11.1 | Réglages : vérifier la présence de S-05, S-08, S-09, S-11, S-17, S-22, S-25, S-35 à S-38, S-40 ; S-01 et S-24 en lecture seule avec leur raison. | Conforme à la liste du MVP. | 19.4 réglages | ☐ |
| 11.2 | Changer S-38 (réglage avec simulation) : simuler, enregistrer. | Simulation exigée, effet décrit ; la valeur et son origine s'affichent ; « Mes choix » la liste. | T-SET-01, T-SET-02 | ☐ |
| 11.3 | Second compte (opérateur) : ouvrir Réglages, Articles suivis, Santé, Clés d'API. | Lecture seule, aucune action d'administration proposée. | 15.8 | ☐ |
| 11.3a | Votre compte (propriétaire) : Réglages › Utilisateurs. | Les deux comptes sont listés : le vôtre avec « Vous », « Propriétaire » et « Administrateur », le second « Opérateur » ; date de première visite ; aucun e-mail. Aucun bouton sur votre ligne (le propriétaire ne peut pas être retiré). | 15.8, `app/DECISIONS.md` 31 | ☐ |
| 11.3b | « Nommer administrateur » sur le second compte › lire la confirmation › confirmer. Rouvrir l'app avec le second compte. | La confirmation nomme ce que le compte pourra faire ; la ligne affiche « Administrateur » et « Désigné administrateur par » votre prénom (ou « Utilisateur Shopify n° … ») ; pour le second compte, Réglages et Santé deviennent modifiables, et la section Utilisateurs est en lecture seule (« Seul le propriétaire… »). | 15.8 | ☐ |
| 11.3c | Avec votre compte : « Retirer l'administration » sur le second compte › confirmer. | Le second compte redevient opérateur (lecture seule à sa prochaine ouverture) ; `audit_log` : `app_user.update`. | 15.8 | ☐ |
| 11.4 | Réglages › Sécurité et exploitation › « Activer l'arrêt d'urgence » › confirmer ; passer une commande suivie. | Bandeau permanent sur tous les écrans ; la commande n'est pas attribuée ; aucune mise en attente. | EF-33, P-02 | ☐ |
| 11.5 | « Reprendre l'automatisation » › confirmer. | La commande en attente reçoit ses unités. | EF-33 | ☐ |

## 12. Santé et exploitation

| # | Action | Résultat attendu | Couvre | ☐ |
|---|---|---|---|---|
| 12.1 | Réglages › Santé, après les étapes précédentes. | Dernière notification récente, passes R1 à R4 exécutées (dates renseignées au bout de 24 h pour R4 et le nettoyage), aucune écriture en attente depuis plus d'1 h. | 17.1, 17.2 | ☐ |
| 12.2 | Si une tâche arrêtée ou une écriture abandonnée apparaît pendant la recette : bouton « Relancer » sur sa ligne. | Bouton en chargement, bandeau « Tâche relancée » / « Écriture relancée » (et toast de l'admin) ; la ligne disparaît ; l'anomalie critique se ferme quand la tâche s'exécute ou que l'écriture part. | 12.7 `task_dead`, `outbox_dead`, `workers/DECISIONS.md` 69 | ☐ |
| 12.3 | Même bouton avec le compte opérateur. | Écran Santé non accessible (explication seule). | 15.8 | ☐ |
| 12.4 | Écriture abandonnée (provoquée si besoin : deux onglets ajoutent des refs au même article pendant une modification manuelle du stock, ou demande à l'équipe d'en créer une sur staging) : bouton « Abandonner » sur sa ligne › lire la confirmation › confirmer. | La confirmation annonce que Shopify ne recevra pas l'écriture et qu'une réconciliation réalignera le stock ; bandeau « Écriture abandonnée » ; la ligne disparaît, l'anomalie `outbox_dead` passe à « résolue » ; les écritures suivantes du même article partent ; après le délai de grâce S-22, un écart restant ouvre `stock_mismatch_*` qui nomme l'écart ; `audit_log` : `outbox.abandon`. | 12.4, 12.7 `outbox_dead`, `workers/DECISIONS.md` 70 | ☐ |

## 13. Désinstallation et réinstallation (PV-29)

À faire en dernier : la vérification dure plus de 48 h.

| # | Action | Résultat attendu | Couvre | ☐ |
|---|---|---|---|---|
| 13.1 | Noter le nombre d'unités (Unités) et l'heure. Applications › Serialis › Désinstaller. | Journaux : `shop.uninstalled` ; plus aucun appel à Shopify. | 9.14 | ☐ |
| 13.2 | Dans l'heure, réinstaller l'app (Dev Dashboard › Install app) et l'ouvrir. | Mêmes unités, mêmes réglages ; une réconciliation complète a lieu avant toute attribution (`shop.reactivated`). | 9.14, 10.5 | ☐ |
| 13.3 | Attendre 48 h après la désinstallation (Shopify envoie `shop/redact`). Surveiller `wrangler tail` ou les journaux Cloudflare autour de l'échéance. | Si `shop/redact` arrive : stocké seulement, **rien n'est effacé** (boutique active). Ouvrir l'app : mêmes unités qu'en 13.1. Noter si Shopify a envoyé ou non `shop/redact` après la réinstallation. **PV-29 levée** avec ce constat. | PV-29, 10.5 | ☐ |

## 14. Vrai CDN Polaris et accessibilité

| # | Action | Résultat attendu | Couvre | ☐ |
|---|---|---|---|---|
| 14.1 | En local, avec le réseau : `VITE_API_MOCK=1 pnpm --filter @serialis/admin build && UI_TESTS_REAL_CDN=1 pnpm --filter @serialis/ui-tests e2e` | Suites axe, clavier, états et i18n vertes sur les vrais composants ; assertions `@real-cdn` vertes (éléments définis par le vrai script, anneau de focus de chaque composant, LCP ≤ 2,5 s, CLS ≤ 0,1). | T-UX-03, T-UX-05, `app/DECISIONS.md` 25 | ☐ |
| 14.2 | Dans l'admin réel, Chrome DevTools › Lighthouse (navigation, mobile) sur l'accueil de l'app. | Pas de violation d'accessibilité grave ; LCP et CLS dans les seuils Built for Shopify. | 15.9 | ☐ |
| 14.3 | Contrastes et focus des composants Polaris dans l'admin (clair et, si proposé, sombre) : parcourir chaque écran au clavier. | Focus toujours visible, textes lisibles, état et gravité jamais portés par la couleur seule. | 15.9 | ☐ |
| 14.4 | Remplir la grille d'audit manuelle WCAG 2.2 AA (lecteur d'écran, zoom 200 %, recadrage 320 px) sur l'accueil, Unités, Anomalies, Réglages et les 4 blocs. | Grille remplie, écarts ticketés. | T-UX-03, `app/DECISIONS.md` 22 | ☐ |
| 14.5 | Passer la langue de votre compte Shopify en anglais, rouvrir l'app et les blocs. | Tout en anglais, aucun texte français ni clé visible. | 15.9 | ☐ |

## 15. Demandes à Shopify (suivi, pas de test)

| # | Action | Résultat attendu | Couvre | ☐ |
|---|---|---|---|---|
| 15.1 | Partner Dashboard › app de production › Accès aux données protégées : vérifier l'état de la demande de niveau 1. | Demande envoyée (date notée). | PV-2 | ☐ |
| 15.2 | Même endroit : demande `read_all_orders`. | Demande envoyée sur l'app de production (date notée) ; réponse attendue avant le lot 1. | PV-18 | ☐ |

## Bilan

| Critère (19.4) | Étapes | Résultat |
|---|---|---|
| T-MVP-01 | 3.2 à 3.6, 4.4 à 4.6 | |
| T-MVP-02 | 5.1 à 5.3 | |
| T-MVP-03 | 6.1, 6.4, 6.5, 8.1 | |
| T-MVP-04 | 5.4 à 5.6 | |
| T-MVP-06 | 6.1 à 6.3, 8.3, 9.1, 9.2 | |
| T-MVP-07 | 5.2, 5.3, 10.3 | |
| T-MVP-08 | 5.5, 5.6, 7.2, 7.4 | |
| T-MVP-09 | 10.1, 10.2 | |
| T-MVP-10 | 7.1 | |
| Droits (15.8), abandon (12.4) | 11.3 à 11.3c, 12.2 à 12.4 | |
| T-UX-02 (action variante, admin réel) | 3.3, 3.7, 3.8 | |
| T-UX-03, T-UX-05 (vrai CDN) | 1.9, 14.1 à 14.5 | |
| T-UX-07 (admin réel) | 6.3 | |
| PV-3 | 9.3 | levée / repli |
| PV-14 | 8.1, 8.2 | levée / repli |
| PV-19 | 9.5, 9.6 | levée / repli |
| PV-23 | 7.3 | levée / repli |
| PV-24 | 8.4, 8.5 | levée / repli |
| PV-29 | 13.1 à 13.3 | levée / repli |
| PV-2, PV-18 demandées | 15.1, 15.2 | |
| Admin réel (App Bridge, Polaris, liens) | 1.1 à 1.8, 2.2, 3.9 | |

T-MVP-05 (rafale de 50 commandes en une minute) n'est pas dans cette liste : la boutique de développement est plafonnée à 5 commandes par minute (PV-20) ; il est couvert par le simulateur (`workers/test`).
