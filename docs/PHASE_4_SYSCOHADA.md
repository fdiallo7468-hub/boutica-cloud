# Boutica Cloud 3.0 — Phase 4 SYSCOHADA

## Périmètre approuvé

Phase 4 est exclusivement consacrée à la comptabilité générale SYSCOHADA révisée, système normal, pour les comptes individuels. Marché initial : Mali. La conformité réglementaire finale doit être revue par un professionnel compétent.

Hors périmètre : Business Assistant, Data Warehouse, ML/DL, prévisions, fiscalité malienne détaillée, consolidation, banques et assurances.

## Architecture

- Monolithe NestJS existant, PostgreSQL/Neon et Drizzle.
- Module métier `accounting`, isolé par `business_id` et optionnellement `location_id`.
- Montants comptables exacts (NUMERIC / représentation décimale), jamais de flottants binaires.
- Comptabilisation transactionnelle, partie double, idempotence, périodes contrôlées et écritures validées immuables.
- Migrations Drizzle additives uniquement. Aucun accès à Neon production ni déploiement Render dans le cadre du développement.

## Sous-phases

1. **4.1 Fondations** : profil comptable, plan de comptes versionné, exercices, périodes et journaux.
2. **4.2 Moteur d'écritures** : pièces, lignes débit/crédit, validation, numérotation, idempotence, contrepassation et audit.
3. **4.3 Intégration opérationnelle** : ventes, achats, règlements, créances, dépenses, retours et stocks.
4. **4.4 Comptabilité générale** : grand livre, auxiliaires clients/fournisseurs, balance et soldes d'ouverture.

**Fin de périmètre : la Phase 4 s'arrête strictement à 4.4. Les anciennes rubriques 4.5 et 4.6 ne font pas partie de Boutica Cloud 3.0 dans cette roadmap.**

## Critères d'acceptation transversaux

- Toutes les tables métier sont tenant-scoped et les références composites empêchent les associations inter-entreprises.
- Une écriture comptabilisée est équilibrée et non modifiable ; toute correction passe par une contrepassation traçable.
- Une période fermée ou verrouillée refuse toute nouvelle comptabilisation.
- Les événements commerciaux rejoués ne créent pas de doublons.
- Les totaux débit/crédit et les états se réconcilient avec le grand livre.
- Les migrations se rejouent depuis une base vide et depuis la baseline prise en charge.
- Tests unitaires, tests PostgreSQL d'intégration, lint et build de production passent sur le SHA final de la PR.
- Les règles, comptes et états réglementaires sont comparés à des sources officielles et validés par un professionnel SYSCOHADA avant toute revendication de conformité.

## Phase 4.1 — fondations API

Le premier incrément expose le profil comptable, le référentiel de comptes (saisie contrôlée, sans import d'un plan officiel non vérifié), les exercices et les journaux. Le complément API ajoute :

- Gestion des périodes comptables : liste, création rattachée à un exercice, vérification d'inclusion dans les dates de l'exercice et prévention transactionnelle des chevauchements par verrou consultatif PostgreSQL au niveau de l'entreprise.
- Transitions de période uniquement vers **CLOSED** ou **LOCKED** ; une période verrouillée est terminale et une période fermée ne peut qu'être verrouillée.
- Mise à jour limitée des comptes (libellé, sens normal, caractère imputable, activation), sans changement d'identifiant ni de rattachement hiérarchique.
- Mise à jour limitée des journaux (libellé, préfixe de séquence, activation), sans réinitialiser le compteur de séquence ni changer le type/code.

Routes ajoutées :
- `GET /api/v1/accounting/periods`
- `POST /api/v1/accounting/periods`
- `PATCH /api/v1/accounting/periods/:periodId/status`
- `PATCH /api/v1/accounting/accounts/:accountId`
- `PATCH /api/v1/accounting/journals/:journalId`

Les tests PostgreSQL couvrent les chevauchements d'exercices et de périodes, la hiérarchie parent/enfant des comptes et les transitions OPEN → CLOSED → LOCKED. La création concurrente des exercices et les transitions de périodes sont sérialisées au niveau PostgreSQL.

## Phase 4.1 — premier schéma

Migration `0016_syscohada_accounting_foundation.sql` : profil comptable, comptes, exercices, périodes et journaux. Les données de référence du plan comptable ne sont pas encore préchargées ; elles doivent provenir d'un référentiel officiel vérifié, pas d'une liste improvisée.

## Avancement des phases 4.2 à 4.4

### 4.2 — moteur comptable : premier incrément implémenté

Migration `0017_accounting_entries_ledger.sql` :
- En-tête d'écriture rattaché à un journal et à une période de la même entreprise.
- Lignes avec références composites vers les comptes de la même entreprise.
- Montants `NUMERIC(18,2)`, une seule colonne débit ou crédit strictement positive par ligne.
- Numéro unique par entreprise, clé d'idempotence, référence source et lien d'extourne.
- Déclencheurs PostgreSQL empêchant la modification ou suppression d'une écriture comptabilisée et l'ajout/modification/suppression de ses lignes après validation. La création se fait en état DRAFT dans la transaction, puis passe à POSTED après insertion des lignes.
- Validation applicative de l'équilibre débit/crédit, de l'imputabilité et de l'activation des comptes, du journal actif et de la période ouverte.
- Extourne par nouvelle écriture inverse, dans une période ouverte explicitement sélectionnée.

Routes :
- `POST /api/v1/accounting/entries`
- `GET /api/v1/accounting/entries`
- `POST /api/v1/accounting/entries/:entryId/reverse`

### 4.3 — intégrations opérationnelles : partiellement implémentée

L'intégration automatisée couvre désormais les dépenses (`EXPENSE`) et les ventes terminées (`SALE`) lorsqu'un mapping explicite est configuré par l'entreprise. La migration `0021_accounting_multi_line_posting_templates.sql` introduit des lignes de mapping ordonnées, des bases de calcul, des répartitions en pourcentage et la conservation de la localisation sur les écritures. Les anciens mappings de dépenses sont convertis en deux lignes.

Pour les ventes, les modèles utilisent exclusivement les données persistées : total, sous-total, remise et instantané du coût unitaire à la vente multiplié par les quantités. Chaque modèle doit produire une écriture équilibrée ; les bases non disponibles, les comptes inactifs, les auxiliaires invalides et les périodes fermées bloquent la transaction source. Aucun numéro de compte ni mapping n'est inventé.

Les réceptions d'achats, paiements et annulations, retours et mouvements de stock ne déclenchent pas encore d'écritures automatiques. La Phase 4.3 reste donc ouverte. Les traitements fiscaux ne sont pas modélisés et toute revendication de conformité doit être revue par un professionnel SYSCOHADA.

### 4.4 — grand livre et balance : premier incrément implémenté

- Consultation des écritures avec filtres de période/date.
- Grand livre par compte et balance générale agrégée, calculés exclusivement à partir des écritures POSTED.
- Auxiliaires clients/fournisseurs : dimensions de tiers sur les lignes, références composites tenant-safe et consultation chronologique des mouvements.
- Soldes d'ouverture : comptabilisation via un journal OPENING actif, dans une période ouverte, avec partie double et idempotence.

Routes :
- `GET /api/v1/accounting/accounts/:accountId/ledger`
- `GET /api/v1/accounting/customers/:customerId/ledger`
- `GET /api/v1/accounting/suppliers/:supplierId/ledger`
- `POST /api/v1/accounting/opening-balances`
- `GET /api/v1/accounting/trial-balance`

Migration `0019_accounting_auxiliary_ledgers.sql` ajoute les références clients/fournisseurs sur les lignes comptables, protégées par clés étrangères composites et contrainte empêchant d'affecter deux tiers à une même ligne. Les écritures de brouillon sont exclues des grands livres et de la balance.

Les tests PostgreSQL de 4.4 vérifient la réconciliation de la balance (débit = crédit), les mouvements du grand livre, les auxiliaires clients et fournisseurs, le rejet des références auxiliaires inter-entreprises, l'idempotence des soldes d'ouverture et la possibilité de plusieurs sources d'ouverture sur une même date. Les tests du moteur couvrent également l'idempotence, le rejet d'une réutilisation de clé avec un autre contenu, l'extourne unique et l'immutabilité des écritures comptabilisées.

## Contrat d'intégration opérationnelle

Le détail des événements, des bases de calcul, des prérequis de domaine et des critères d'acceptation est maintenu dans `docs/ACCOUNTING_OPERATIONAL_INTEGRATION_CONTRACT.md`. Ce contrat ne constitue pas une validation comptable ; il définit les contrôles à implémenter avant de fermer 4.3.

## État de validation

La Phase 4.3 reste incomplète au-delà des dépenses. La Phase 4.4 est la dernière étape de cette Phase 4 ; aucune étape 4.5 ou 4.6 ne doit être ajoutée. Les scénarios d'acceptation PostgreSQL 4.1, 4.2 et 4.4 sont intégrés ; la clôture technique dépend du passage complet de la CI sur le dernier SHA de la PR, de la revue finale et de la décision explicite sur le périmètre opérationnel restant. Aucune conformité SYSCOHADA réglementaire n'est revendiquée sans revue professionnelle.
