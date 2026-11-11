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
4. **4.4 Comptabilité générale** : grand livre, auxiliaires et balance.
5. **4.5 Immobilisations et clôture** : registre, amortissements, inventaire, régularisations et clôtures.
6. **4.6 États financiers** : bilan, compte de résultat, tableau des flux de trésorerie et notes annexes.

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

Les contrôles de chevauchement des exercices fiscaux, de hiérarchie des comptes et les transitions de périodes devront être couverts par des tests PostgreSQL dédiés avant de considérer 4.1 comme entièrement close.

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

### 4.3 — intégrations opérationnelles : à terminer

Les points d'intégration identifiés sont les ventes, réceptions d'achats, paiements confirmés/annulés, dépenses, retours et ajustements de stock. Leur comptabilisation automatique nécessite un paramétrage explicite des comptes de contrepartie (par exemple caisse/banque, clients, fournisseurs, ventes, achats/stocks, charges et variation de stock/COGS), puis des règles déterministes par type d'événement.

Aucune écriture automatique ne doit être émise avec des comptes supposés. Les adaptateurs transactionnels et le registre idempotent des événements sources restent à implémenter ; tant que ce travail n'est pas achevé, 4.3 n'est pas considérée comme acceptée.

### 4.4 — grand livre et balance : premier incrément implémenté

- Consultation des écritures avec filtres de période/date.
- Grand livre par compte avec cumul débit, crédit et solde courant.
- Balance générale agrégée par compte, avec totaux débit et crédit.

Routes :
- `GET /api/v1/accounting/accounts/:accountId/ledger`
- `GET /api/v1/accounting/trial-balance`

La balance et le grand livre doivent encore recevoir des tests de réconciliation PostgreSQL dédiés. Les auxiliaires clients/fournisseurs et les soldes d'ouverture restent à compléter avant l'acceptation finale de 4.4.

## État de validation

Le développement de ces incréments n'équivaut pas à une acceptation fonctionnelle complète. Le statut CI doit être vérifié sur le dernier SHA de la PR après chaque série de commits. Aucune conformité SYSCOHADA réglementaire n'est revendiquée à ce stade.
