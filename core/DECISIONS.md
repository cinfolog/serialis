# Décisions du moteur pur (`core/`)

Choix faits là où la spécification (`docs/spec/spec.md`) est muette, ambiguë ou contradictoire.
Chaque décision cite la section concernée. Celles marquées **à trancher dans la spec** signalent
une divergence à corriger dans la spec ou dans le code (règle du dépôt : jamais en silence).

## D-01 — Emplacements opaques (11.2, 12.3)

Le moteur utilise un seul identifiant d'emplacement (`LocationId`) pour les unités, les attributions,
l'instantané Shopify et les intentions d'écriture. L'appelant convertit les GID Shopify en
`locations.id` avant l'appel, et l'outbox fait la conversion inverse.

## D-02 — Plan pur et identifiants (12.3 étape 4)

`planOrderSync` ne fait aucune écriture : il rend un plan (attributions à créer ou modifier,
transitions, anomalies, écritures de stock, metafield). `applyPlan` en est l'application de
référence (attribution d'abord, unité ensuite, comme `applyTransition`). Les identifiants viennent
de `options.newId`, qui doit être croissant dans l'ordre lexicographique au sein d'un appel (UUID v7) :
c'est le départage des attributions créées dans la même milliseconde (ordre S-08 et metafield).

## D-03 — `awaiting_unit` ou `insufficient_units` (19.4, 12.7, T-MVP-04, T-MVP-08) — **à trancher dans la spec**

Règle appliquée, celle de 19.4 : `awaiting_unit` quand une unité AVAILABLE libre existe encore à
l'emplacement mais n'a pas été prise (verrouillée, S-05 = manuelle, arrêt d'urgence) ;
`insufficient_units` quand il n'en reste aucune. T-MVP-08 annonce `awaiting_unit` pour « trois
commandées, deux en stock » alors qu'il ne reste alors aucune unité, ce qui contredit 19.4 et
T-MVP-04 / T-MVP-05. Le test du moteur accepte l'une ou l'autre pour ce cas et vérifie la quantité ;
la spec doit choisir.

## D-04 — Quelles unités attribuées peuvent être celles expédiées (F4, 12.3) — **précision à reporter dans la spec**

Une unité attribuée ne peut couvrir une expédition que si elle a été attribuée avant la dernière
expédition de la ligne à cet emplacement (`allocatedAt` ≤ `fulfillment.createdAt`), ou si la
quantité ouverte n'en a plus besoin (unités au-delà de la capacité des ordres ouverts). Une unité
attribuée après une expédition sans unité couvre la quantité restante, jamais l'expédition passée
(qui reste `shipped_without_unit`). Sans cette règle, la synchronisation n'est pas idempotente :
trouvé par les tests de propriétés. L'ambiguïté d'une expédition partielle (`shipped_unit_to_confirm`)
ne porte que sur ces unités éligibles.

## D-05 — Motif de désattribution et remise en stock (F3, F5, 11.2)

Les attributions portent `releaseKind` (`restocked`, `not_restocked`, `relocated`,
`ignored_order`, `manual`), absent de 11.2 : il faudra une colonne `allocations.release_kind`
(migration additive). Il permet à une synchronisation rejouée de savoir quelle part de
l'information de remise en stock d'une ligne a déjà été consommée.

- Budget de remise en stock d'une ligne = quantités remboursées `CANCEL` et `LEGACY_RESTOCK` +
  retraits par modification avec `restock = true`. Les unités libérées au-delà (NO_RESTOCK,
  modification sans remise en stock ou inconnue, annulation sans ligne de remboursement) passent
  TO_VERIFY avec `unit_to_verify`.
- `LEGACY_RESTOCK` est traité comme `CANCEL` (ligne non expédiée) ; sur une ligne expédiée il n'est
  pas traité comme un retour dans le MVP (anciennes commandes seulement).
- Le moteur n'utilise pas `currentQuantity` : la quantité restante des ordres d'expédition fait foi.

## D-06 — Retours simples (F6, S-17, 19.4)

- Approbation = statuts `OPEN` et `CLOSED` ; `REQUESTED` est ignoré ; `DECLINED` et `CANCELED`
  ramènent RETURN_PENDING → SHIPPED.
- L'unité attendue est notée sur l'attribution (`returnLineItemGid`), qui tient lieu de
  `expected_returns.identified_unit_ids` dans le moteur ; le magasin fait la correspondance.
- Les refs saisies arrivent déjà résolues par `designateUnit` (`returnIdentifications`) ; une ref
  inconnue ou d'une unité non vendue sur cette ligne ouvre `return_unit_mismatch`, sans écriture.
- Les dispositions s'appliquent aux unités identifiées, dans l'ordre d'identification ; le reste
  ouvre `return_unidentified` et une quantité expliquée (déficit, `available`) pour la part remise
  en stock.
- Remboursement `RETURN` hors retour Shopify (EF-23) : ligne de retour synthétique
  `<refundGid>#<lineItemGid>`, disposition « remise en stock » à `RefundLineItem.location`.
  Ignoré si la ligne figure dans un retour Shopify, pour ne pas compter deux fois un retour traité
  par `returnProcess`.
- `NOT_RESTOCKED` → SCRAPPED (S-19 hors MVP, valeur par défaut) ; `PROCESSING_REQUIRED` →
  QUALITY_CONTROL avec `quality_control` +1, ou déplacement `available` → `quality_control` si
  `options.processingRequiredAddsAvailable` (porte PV-3, levée le 19/11/2026 : Shopify n'ajoute rien, la
  branche par défaut reste active ; une disposition sans emplacement s'applique à l'emplacement de l'unité).
- S-17 = non : seulement pour une ligne de quantité 1 avec exactement une attribution vendue.

## D-07 — Anomalies (11.2, 12.7)

- `fingerprint` est une clé canonique (type + identifiants du sujet triés) ; le magasin en garde
  le SHA-256.
- Types suivis par la synchronisation (ouverts et résolus selon l'état voulu, résolution
  `auto_resolved`) : `awaiting_unit`, `insufficient_units`, `shipped_without_unit`,
  `pos_sold_without_unit`, `preexisting_sale_to_designate`, `shipped_unit_to_confirm`,
  `return_unidentified`. Types résolus par une personne (`unit_to_verify`, `return_unit_mismatch`,
  `invalid_serial_property`) : ouverts une seule fois par empreinte, jamais rouverts par un rejeu.
- `pos_sold_without_unit` est un avertissement (MVP, 12.7).

## D-08 — Expéditions comptées (F4)

Les expéditions `SUCCESS`, `OPEN` et `PENDING` comptent comme expédiées (Shopify a déjà retiré la
quantité de l'ordre d'expédition) ; `CANCELLED`, `ERROR`, `FAILURE` non. Les expéditions antérieures
à `activatedAt` ne sont jamais à couvrir (EF-01) ; les attributions de source `migration` sont hors
de cette comparaison.

## D-09 — Déplacement d'ordre et scission (F13, EF-16)

Les attributions actives sont rattachées par ligne de commande et emplacement, puis aux lignes
d'ordre ouvertes ayant de la capacité (références d'ordre mises à jour sans désattribution). Si la
capacité totale de la ligne n'a pas baissé, les unités en trop à l'ancien emplacement sont
`relocated` (ALLOCATED → AVAILABLE, écrit par Shopify) ; seule la baisse nette consomme le budget de
remise en stock. Les unités gardées en premier sont celles que S-08 libère en dernier.

## D-10 — Phases d'une synchronisation (12.3)

Pour toute la commande : expéditions et désattributions de chaque ligne, puis retours, puis
attributions, puis anomalies. Une unité libérée par une ligne ou remise en stock par un retour est
donc visible de toutes les attributions du même passage (sinon le rejeu n'est pas vide).

## D-11 — Commandes de test ignorées (S-11, 8.1)

Les attributions actives d'une commande de test ignorée sont libérées (`ignored_order`, sans
écriture) ; les attributions expédiées restent ; la quantité expédiée non couverte est une quantité
expliquée `test_order_shipment`.

## D-12 — Propriété `_serialis_units` (F8, 19.4)

Sans extension de caisse dans le MVP, aucun jeton ne peut être authentique : une propriété non vide
ouvre `invalid_serial_property` et la ligne suit F1. La vérification HMAC des jetons (lot 3) sera
faite hors du moteur, qui recevra des jetons déjà vérifiés.

## D-13 — Désignation par ref (15.5)

Ref entière, ou exactement 4 caractères quand ils terminent une seule ref parmi les candidates.
Comparaison toujours insensible à la casse ; espaces intérieurs retirés selon S-36 ; identifiants
retirés (EF-08) exclus. Une saisie de 4 caractères égale à la ref entière d'une unité et à la fin de
celle d'une autre est ambiguë (refusée). Jamais de préfixe.

## D-14 — Réglages (6.6, 19.4)

- Catalogue limité au MVP + S-01 et S-24 (fixés à « ne pas bloquer », non enregistrables). S-04,
  S-07 et S-19 n'ayant pas d'objet dans le MVP, leurs valeurs par défaut sont codées dans le moteur
  (à la commande, à confirmer, rebut).
- Le résolveur ignore une valeur stockée invalide ou sur une portée non permise (la validation se
  fait à l'écriture, T-SET-01). S-37 vaut Luhn par défaut pour le type `imei`. Sur un emplacement
  externe, S-22 vaut 2 h sauf valeur posée sur l'emplacement.
- S-36 est une seule valeur `{ stripSpaces, normalizeUpper }` ; S-40 `{ recipients, outgoingWebhook,
  dailyDigest }` (destinataires marchands seulement, jamais de donnée client).

## D-15 — Divers

- Commande annulée : aucune quantité à attribuer, quel que soit le statut lu des ordres d'expédition.
- Lignes `preexisting` : ni attribuées ni comptées dans `uncovered_lines`.
- Metafield : seules les lignes ayant au moins une unité ; aucune unité → pas de metafield (supprimé
  s'il existe) ; commande non suivie jamais touchée ; S-38 = non → suppression.
- La désignation des unités emballées (écran de préparation, lot 1) n'est pas modélisée : dans le
  MVP, une expédition partielle ambiguë est toujours « à confirmer ».
- `changeFrom` n'est jamais rempli par le moteur : l'outbox le lit juste avant le premier envoi (12.4).
- Mode exemplaire unique (lot 4) : articles ignorés par `planOrderSync` ; I6 est vérifié par
  `checkInvariants` si l'appelant fournit les niveaux des variantes.
