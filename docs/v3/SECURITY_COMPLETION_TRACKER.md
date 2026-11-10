# Boutica Cloud 3.0 — Security completion tracker

**Status:** hardening in progress; not yet approved for production.

## Verified foundation

- CI run #74 passed: migration replay, lint, unit tests, PostgreSQL integration tests and production TypeScript build.
- Tenant IDs for business-location APIs are resolved server-side.
- Location reads/writes are constrained by both resource ID and business ID.
- The initial permission guard validates persisted active business and membership.
- `TenantTransactionService` sets transaction-local tenant context on a single checked-out PostgreSQL connection.
- `audit_events` is append-only at the database layer.

## Remaining mandatory work before Phase 1 can be marked complete

1. Apply membership/permission checks consistently to every tenant API, including nested resources and background jobs.
2. Move sensitive business writes to a shared transaction boundary that sets tenant context and writes the audit event in the same transaction.
3. Complete the tenant-owned table inventory, including child tables and worker/outbox paths.
4. Add RLS policies for the complete table inventory only after all application paths propagate transaction-local tenant context.
5. Prove connection-pool isolation with alternating-tenant integration tests and negative cross-tenant tests for each module.
6. Add audit coverage for sale, purchase, stock adjustment, return, expense, receivable, payment and payment cancellation.
7. Verify database runtime grants/default privileges and restrict audit-log reads.
8. Review migrations and backup/restore procedure before any production rollout.

## Explicit safety rule

Do not enable partial RLS as a shortcut. Do not claim full tenant isolation while any tenant-owned table or background path is outside the transaction boundary. Keep production Neon, Render and PR merge untouched until a separate rollout approval.
