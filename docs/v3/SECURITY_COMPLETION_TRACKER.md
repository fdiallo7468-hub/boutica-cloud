# Boutica Cloud 3.0 — Security completion tracker

## Release-hardening update — 2026-11-11

### Audit coverage increment

The feature branch now writes the following append-only audit events inside the same Drizzle transaction as the business mutation:
- `sale.created` and `sale.cancelled`
- `purchase.received`
- `return.completed`
- `stock.adjusted`
- `expense.created`
- `receivable.created`
- `payment.recorded` and `payment.cancelled`

`AuditEventsService.appendInTransaction` uses the transaction executor, so an audit insert failure rolls back the associated business write. Metadata is minimized and excludes free-form cancellation reasons and stock notes. Unit coverage has been added for the transactional writer. The current CI run must still pass before this increment is accepted.

### Neon backup / restore rehearsal

- A restore was exercised from the existing manual snapshot `before-test-data-cleanup-2026-10-23` into a separate branch named `restore-rehearsal-2026-11-11`.
- The snapshot is dated 2026-10-23; this proves the restore workflow for that historical snapshot, not a current production recovery point.
- Creating a new manual snapshot was rejected by Neon because the project's snapshot limit was exceeded. Existing snapshots were not deleted.
- The automatic snapshot schedule is empty. A fresh backup and an agreed retention/frequency policy remain required before production migration.
- The production default branch `br-lucky-union-b5cqpuuo` was restored as the default `production` branch after the rehearsal; its migration ledger remains at 11 and the original business data remains present.

### Production database observations

- The production branch currently records migrations through journal entry 11. Feature migrations 0012–0019 are not applied there.
- The existing runtime role `boutica_runtime` has broad CRUD grants on the current public tables. A complete least-privilege/default-privilege review and audit read-access restriction remain open.
- The `businesses` table has RLS enabled without a corresponding policy; the other inspected public tables have RLS disabled.
- `TenantTransactionService` currently exists but is not adopted as a universal request/worker transaction boundary. Enabling RLS on the full tenant inventory now would break legitimate query paths or create incomplete protection.

### Current release decision

RLS remains **not enabled as a blanket policy**. The next required engineering increment is a request-scoped Drizzle transaction context (including all authenticated routes and background workers), then a complete table/child-table policy matrix and alternating-tenant pool-isolation E2E tests. Do not merge or deploy until those tests pass.


**Status:** hardening in progress; not approved for production. CI success does not constitute security sign-off.

## Verified foundation

- CI run #74 passed: migration replay, lint, unit tests, PostgreSQL integration tests and production TypeScript build.
- Tenant IDs for business-location APIs are resolved server-side.
- Location reads/writes are constrained by both resource ID and business ID.
- The initial permission guard validates persisted active business and membership.
- Tenant context resolution now re-checks the persisted `business_members` row on each tenant-scoped request and uses the persisted membership role; a revoked-membership E2E regression test is included.
- Notification outbox processor/worker completion, retry, lease-refresh and claim mutations now include both the outbox record ID and its `business_id` in their predicates; manual retry also rechecks `business_id` in the final UPDATE.
- `TenantTransactionService` sets transaction-local tenant context on a single checked-out PostgreSQL connection.
- `audit_events` is append-only at the database layer.

## Remaining mandatory work before Phase 1 can be marked complete

1. Verify membership/permission checks consistently on every tenant API, including nested resources and background jobs. Current tenant decorator protects only routes that actually invoke it; review controller-level coverage and service-level ownership predicates.
2. Move sensitive business writes to a shared transaction boundary that sets tenant context and writes the audit event in the same transaction.
3. Complete the tenant-owned table inventory, including child tables and all worker/outbox paths. The notification outbox is now explicitly tenant-qualified on mutations; other worker paths still require inventory.
4. Add RLS policies for the complete table inventory only after all application paths propagate transaction-local tenant context.
5. Prove connection-pool isolation with alternating-tenant integration tests and negative cross-tenant tests for each module. Existing transaction unit tests verify transaction-local settings on one checked-out connection, but this is not yet a pool-isolation proof.
6. Add audit coverage for sale, purchase, stock adjustment, return, expense, receivable, payment and payment cancellation, and verify audit insertion shares the exact business transaction.
7. Verify database runtime grants/default privileges and restrict audit-log reads. Migration 0013 makes audit events append-only but does not by itself prove runtime role grants or tenant-scoped audit reads.
8. Review migrations and execute a documented backup/restore rehearsal before any production rollout.

## Explicit safety rule

Do not enable partial RLS as a shortcut. Do not claim full tenant isolation while any tenant-owned table or background path is outside the transaction boundary. Keep production Neon, Render and PR merge untouched until a separate rollout approval.

## Decision — Phase 1 development gate (2026-11-11)

Phase 1 is accepted as the **development foundation for Phase 3**. This is not a production security sign-off and does not authorize deployment.

### Verified release-critical baseline
- The latest feature-branch CI run #42930110067 passed in full on `50f83bb27e0cb6a5afe8bbc22bd2c92e1a3c4fd6`: migration replay, lint, unit tests, PostgreSQL integration tests and production TypeScript build.
- Tenant selection is revalidated against persisted membership for tenant-scoped requests; revoked membership is covered by an E2E regression test.
- Location APIs constrain resources by both location ID and business ID.
- Notification outbox state mutations are tenant-qualified by business ID.
- The Phase 2 location-aware operational schema and workflows are present in the same development branch.

### Explicitly deferred hardening (must be completed before production launch)
These items will no longer block Phase 3 feature development, but remain release gates:
- Full adoption of `TenantTransactionService` across every sensitive write and matching audit insertion in the same transaction.
- Full tenant-owned table/worker inventory and proof of pool isolation across every module.
- RLS policy design and activation after complete transaction-context coverage; no partial RLS.
- Complete audit coverage for all financial/stock operations and restricted audit-log read grants.
- Runtime DB role/default-privilege verification and a documented backup/restore rehearsal.
- Full module-by-module authorization review for routes that do not currently resolve tenant context.

### Operating rule
Continue feature development on the existing `feat/boutica-cloud-v3-foundation` branch and PR #5. Do not create a new branch or PR. Keep tenant membership checks, business ownership predicates, financial consistency and negative cross-tenant tests in the definition of done for new Phase 3 work. No production migration, Render deployment or PR merge is authorized by this decision.
