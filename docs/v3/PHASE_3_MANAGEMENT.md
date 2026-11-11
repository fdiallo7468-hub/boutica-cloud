# Boutica Cloud 3.0 — Phase 3: Management, BI & CRM

**Status:** Implementation in progress — CRM metrics/search/segments, BI KPI baseline and transactional loyalty ledger are being integrated and validated  
**Branch / PR:** `feat/boutica-cloud-v3-foundation` / PR #5  
**Prerequisites:** Phase 1 development gate accepted; Phase 2 operations and location-aware inventory integrated.

## Product objective

Give business owners and managers a reliable view of business performance and tools to retain and understand customers. Extend the existing NestJS modular monolith; do not introduce microservices or replace working v2.1 contracts.

## Workstream A — Business intelligence

### Implemented increment
- Dashboard now exposes completed sales count and average basket for the selected date window.
- Dashboard includes revenue for the immediately preceding equal-duration period.
- Invalid or reversed date windows are rejected with HTTP 400. Existing exports and dashboard continue to use inclusive date boundaries.

The existing `GET /api/v1/reports/dashboard` and Excel/PDF exports are the starting point. Evolve them into a consistent reporting layer:
- Date-range validation, inclusive/exclusive boundary consistency and safe defaults.
- Revenue, completed sales count, average basket, gross margin estimate, expenses, estimated operating result, outstanding/overdue receivables and inventory valuation.
- Time-series breakdowns (day/week/month), previous-period comparison and validated location filters.
- Top products/variants, low-stock alerts and recent sales.
- Location-aware filters using server-validated location IDs; organization-wide totals remain the default.
- Export parity: report totals and filters must match dashboard calculations.
- Explicitly label estimates; do not call gross margin or profit accounting-grade until a proper ledger exists.

### Implemented increment
- `GET /api/v1/customers/segments` groups active customers into deterministic new, active, at-risk, inactive and high-value segments; its thresholds are returned in the API response.
- `GET /api/v1/customers?search=...` now supports tenant-scoped partial matching on customer name and phone while preserving pagination and archive filtering.
- `GET /api/v1/customers/:id/summary` provides completed-sale count, lifetime value, average basket and last purchase, with cross-tenant 404 behavior.
- Loyalty endpoints: `GET/PUT /api/v1/loyalty/configuration` and `GET /api/v1/loyalty/customers/:customerId`.

## Workstream B — CRM

Extend the existing customer module:
- Customer profile with contact details, active/archive state and transaction summary.
- Customer purchase history, lifetime spend, order count, average basket and last purchase.
- Segmentation based on deterministic rules (new, active, at-risk, inactive, high-value); thresholds configurable and documented.
- Search, pagination and date/location filters.
- Customer sales history is available through the existing tenant-scoped sales listing filtered by `customerId`; a dedicated CRM history response remains desirable.
- Preserve historical sales and receivables when a customer is archived.
- All queries and nested resources remain scoped to the authenticated business.

## Workstream C — Loyalty

Introduce a ledger-based loyalty foundation only after CRM identity and transaction behavior are stable:
- Per-business loyalty configuration (earn rate, redemption value, minimum redemption, expiry policy).
- Append-only points ledger with source transaction, actor, tenant and idempotency key.
- Earn points only from completed, non-cancelled sales; reverse/adjust points on returns and cancellations.
- Prevent negative balances and duplicate awards.
- Implemented migration `0015_loyalty_ledger.sql`, per-business configuration, unique idempotency keys, immutable database trigger and transaction-bound sale awards/return reversals. Redemption is intentionally not exposed until the ledger and redemption accounting are separately verified.
- Do not add customer-facing redemption until ledger invariants and tests are in place.

## Delivery order

1. Reporting correctness and API contracts.
2. CRM customer metrics, history and segmentation.
3. Loyalty schema, service and idempotent ledger.
4. Tests for tenant isolation, date boundaries, aggregation consistency, return reversals and duplicate event handling.
5. Documentation and CI verification.

## Non-goals for this phase

- No general ledger / SYSCOHADA posting system (separate accounting workstream).
- No AI predictions or external BI warehouse.
- No production migration, Render deployment, or PR merge without separate authorization.

## Definition of done

- All aggregates are tenant-scoped and tested against seeded PostgreSQL data.
- Date filters and location filters produce deterministic, documented results.
- Dashboard and exports agree on totals.
- CRM metrics reconcile with underlying sales and returns.
- Loyalty ledger is append-only and idempotent; proportional return reversals are transaction-bound and tested. Sale cancellation reversal remains pending if/when a supported cancellation workflow is introduced.
- Lint, unit tests, PostgreSQL integration tests and production build pass on PR #5.
