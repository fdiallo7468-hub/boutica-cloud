# Boutica Cloud 3.0 — Security completion tracker

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
