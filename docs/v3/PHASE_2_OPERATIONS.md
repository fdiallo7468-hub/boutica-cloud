# Boutica Cloud 3.0 — Phase 2: Operations & Finance

**Branch:** `feat/boutica-cloud-v3-phase-2-operations`  
**Base:** Phase 1 foundation branch  
**Status:** In progress  
**Compatibility target:** preserve existing `/api/v1` contracts while adding location-aware fields.

## Goals

Deliver reliable daily operations for multi-location African businesses without rewriting the v2.1 modular monolith.

### Workstreams

1. **Commercial operations**
   - Sales, quotes/invoices, returns and customer balances.
   - Server-derived business and location context; no client-controlled tenant ownership.
   - Idempotent writes and transactional stock/finance effects.
2. **Inventory**
   - Per-location stock balances and movement history.
   - Purchase receipts increase the receiving location.
   - Sales decrement the selling location.
   - Returns restore stock to the originating sale location; damaged returns remain excluded from sellable stock.
   - Keep legacy `stock` as a compatibility aggregate during client migration.
3. **Purchasing**
   - Supplier validation, purchase receipt, stock receipt and payable workflow.
   - Every purchase and movement is linked to a location.
4. **Cash and finance**
   - Expenses, receivables, payments and cancellations are location-aware.
   - Reconciliation and cash sessions are subsequent increments; do not infer cash balances from payment rows alone.
5. **Accounting foundation**
   - Next increment: versioned chart of accounts and journals.
   - Posted journal entries must balance (debits = credits), be immutable, and reference an open accounting period.
   - SYSCOHADA account mapping is configurable by country and version; country-specific tax/fiscal compliance requires local expert review.

## Implemented in this increment

- Migration `0014_operational_locations_inventory.sql`:
  - Adds mandatory `location_id` to sales, purchases, expenses, receivables, payments and stock movements.
  - Backfills existing rows to each tenant's default location and aborts if a default location is missing.
  - Adds composite tenant/location foreign keys to prevent attaching a record to another business' location.
  - Creates `inventory_balances`, with a non-negative quantity check and tenant/location/variant uniqueness.
  - Seeds the new location balance from legacy stock snapshots.
- Drizzle schema updated for the location-aware operational records and per-location inventory.
- Sales, purchase receipt, returns, manual stock adjustment, expenses, receivables and payments now assign a server-resolved location.
- Sale and purchase flows update the per-location inventory balance while preserving legacy stock behavior.

## Compatibility and rollout

- Existing clients continue using the default location; no client-supplied location ID is trusted yet.
- The default location is resolved from the authenticated business on the server.
- Multi-location selection in client applications is a later API/UI increment.
- Legacy `stock` remains in place until every client and workflow reads/writes location balances.
- Migration is additive and is validated only in CI's disposable PostgreSQL environment. It must not be run on production until a verified backup, migration-state check and rollout review are completed.

## Acceptance criteria

- Migration replay succeeds from an empty PostgreSQL database and from the supported v2.1 baseline.
- Existing operational rows are preserved and mapped to a valid default location.
- Cross-tenant location references are rejected by database constraints.
- Sales, purchases, returns and adjustments keep legacy aggregate stock and location balances consistent.
- Every operation is covered by unit and PostgreSQL integration tests.
- No production Neon migration, Render deployment or PR merge is implied by this branch.
