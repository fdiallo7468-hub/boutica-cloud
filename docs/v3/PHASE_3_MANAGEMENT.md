# Boutica Cloud 3.0 — Phase 3: Management, BI & CRM

**Status:** Implementation complete — final PostgreSQL/CI validation pending  
**Branch / PR:** `feat/boutica-cloud-v3-foundation` / PR #5  
**Prerequisites:** Phase 1 development gate accepted; Phase 2 operations and location-aware inventory integrated.

## Product objective

Give business owners and managers a reliable view of business performance and tools to retain and understand customers. Extend the existing NestJS modular monolith; do not introduce microservices or replace working v2.1 contracts.

## Workstream A — Business intelligence

### Implemented increment
- Dashboard exposes revenue, completed sale count, average basket, discount totals, gross-margin estimate, estimated operating result, inventory valuation, receivables, low-stock alerts and top/recent sales.
- Day/week/month time series and equal-duration previous-period revenue comparison are available.
- Dashboard supports server-validated location filtering; stock valuation and low-stock alerts use per-location balances when filtered.
- Excel/PDF sales exports apply the same date/location filters; Excel grand totals use actual sale totals after discounts rather than summing undiscounted line totals.
- Inventory Excel/PDF exports accept a server-validated location filter.
- Estimated profit is explicitly flagged as an estimate; this is not general-ledger accounting.
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
- Implemented migration `0015_loyalty_ledger.sql`, per-business configuration, unique idempotency keys, immutable database trigger and transaction-bound sale awards, proportional return reversals and cancellation reversals.
- `POST /api/v1/sales/:id/cancel` atomically restores stock and reverses points for unpaid sales without completed returns. It cancels unpaid receivables, and blocks cancellation when confirmed payments or completed returns exist.
- Customer balance/history is exposed at `GET /api/v1/loyalty/customers/:customerId`.
- Redemption is deliberately not exposed: it needs a separately reviewed cash/discount settlement flow and concurrency controls.
- Do not add customer-facing redemption until ledger invariants and tests are in place.

## Delivery order

1. Reporting correctness and API contracts.
2. CRM customer metrics, history and segmentation.
3. Loyalty schema, service and idempotent ledger.
4. Tests for tenant isolation, date boundaries, aggregation consistency, return reversals and duplicate event handling.
5. Documentation and CI verification.

## Implementation closeout checklist

- [x] BI dashboard KPIs, comparisons, time series and location filters.
- [x] Discount-aware estimated margin and explicit estimate labeling.
- [x] Sales and inventory exports with location parity.
- [x] CRM search, profile summary, net lifetime metrics, segmentation and paginated history.
- [x] Loyalty configuration, append-only ledger, sale earning, proportional return reversal and safe sale-cancellation reversal.
- [x] E2E coverage for loyalty earning/reversals, CRM return reconciliation, BI time series and cross-tenant location rejection.
- [ ] Latest PR #5 CI green on the final head SHA.

A green CI run is the final development gate. Production Neon migration, Render deployment and PR merge remain separate approval steps.

## Non-goals for this phase

- No general ledger / SYSCOHADA posting system (separate accounting workstream).
- No AI predictions or external BI warehouse.
- No production migration, Render deployment, or PR merge without separate authorization.

## Definition of done

- All aggregates are tenant-scoped and tested against seeded PostgreSQL data.
- Date filters and location filters produce deterministic, documented results.
- Dashboard and exports agree on totals.
- CRM net lifetime value reconciles with completed sales less completed returns.
- Loyalty points are earned only on completed sales, with append-only/idempotent entries and compensating reversals on returns and supported cancellations.
- Loyalty ledger is append-only and idempotent; proportional return and cancellation reversals are transaction-bound and tested. Cancellation is intentionally rejected for sales with completed returns or confirmed payments.
- Lint, unit tests, PostgreSQL integration tests and production build pass on PR #5.
