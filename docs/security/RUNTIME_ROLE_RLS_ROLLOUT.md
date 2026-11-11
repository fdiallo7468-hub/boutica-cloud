# Boutica Cloud — Runtime PostgreSQL role and RLS rollout

Status: implementation plan / audit evidence. No production database or Render environment variable has been changed.

## Decision

- NestJS application runtime must use the least-privileged `boutica_runtime` login role.
- `neondb_owner` remains an administrative/migration owner only; it must not be used by HTTP request pools, Better Auth pools, workers, or scheduled jobs.
- Do not switch Render's `DATABASE_URL` until the gates below pass.

## Verified environment (2026-11-11)

Neon project: `late-flower-80953903`. Rehearsal branch: `br-proud-flower-b5tpo59z` (`recovery-rehearsal-current-2026-11-11`), a current copy of production, not a PITR test.

Role inspection:
- `boutica_runtime` can LOGIN and does not have SUPERUSER or BYPASSRLS.
- `neondb_owner` has BYPASSRLS.
- Existing grants for `boutica_runtime` are broader than a least-privilege runtime policy; revoke/grant changes are not yet approved for execution.
- The rehearsal branch currently has 30 public tables, 29 with RLS disabled and `businesses` with RLS enabled but no policies. No rows were returned by `pg_policies`.
- The database migration ledger currently contains migrations through `0010_atomic_user_business_provisioning`. The feature branch's Drizzle journal contains migrations `0011` through `0019` after that point. The rehearsal database is therefore behind the branch schema; it is not yet a valid test target for the current full application schema.

## Application architecture findings

1. `DatabaseService` owns a shared `pg.Pool` and falls back to `baseDb` whenever there is no request-local `TenantDatabaseContext`.
2. `TenantTransactionService.run` starts a transaction and sets transaction-local `app.business_id`, `app.actor_user_id`, and `app.request_id`.
3. `TenantDatabaseInterceptor` resolves Better Auth session and membership before opening the tenant transaction. Unauthenticated or unresolved requests continue without tenant context; tenant-scoped controllers must reject missing context.
4. `src/auth/auth.ts` creates a separate Better Auth `pg.Pool` using `DATABASE_URL`. This pool is used to resolve membership before tenant context exists. Any RLS design must explicitly account for this pre-context auth flow; blindly enabling RLS on auth tables would break session lookup and signup.
5. The notification outbox worker claims events across businesses using `baseDb` outside a tenant request. It must not receive a broad tenant-data bypass. It needs a dedicated narrowly scoped queue execution path (e.g. SECURITY DEFINER functions with fixed search_path and restricted EXECUTE, or a separately isolated worker role/service).
6. `sale_items`, `purchase_items`, and `return_items` lack a direct `business_id`; policies must validate ownership through their parent records and prevent cross-tenant parent/child references.
7. Migration `0011_repair_business_provisioning_rls.sql` explicitly disables the incomplete `businesses` RLS state because no complete request-scoped policy layer exists yet. Do not reverse this by toggling RLS alone.

## Table classification to implement

- Tenant-owned direct key: `business_activities`, `business_locations`, `business_module_configurations`, `customers`, `device_serials`, `expenses`, `idempotency_keys`, `notification_outbox`, `offline_operations_log`, `payment_cancellations`, `payments`, `products`, `purchases`, `push_devices`, `receivables`, `returns`, `sales`, `stock`, `stock_movements`, `suppliers`, `sync_devices`, `variants`, and accounting/loyalty/location tables introduced by later migrations.
- Tenant-owned through parent: `sale_items` -> `sales`; `purchase_items` -> `purchases`; `return_items` -> `returns` (also validate linked sale item / variant tenant).
- Membership/bootstrap control plane: `businesses`, `business_members`. Membership lookup must permit a user to verify only their own membership before the tenant transaction; membership writes must be constrained to authorized business roles and provisioning must remain atomic.
- Global authentication control plane: `users`, `sessions`, `accounts`, `verifications`. Preserve Better Auth's pre-session lookup, signup, password reset, and session revocation semantics. Do not apply generic tenant policies to these tables without a separate auth design and integration tests.

This is a classification, not authorization to apply policies yet. Confirm the complete schema after migrations 0011–0019 are replayed on a disposable branch.

## Required implementation gates

1. Reconcile the database migration ledger with the feature branch's journal and replay migrations 0011–0019 on a disposable Neon branch only. Confirm all migration checksums and schema objects.
2. Inventory every `DatabaseService.db`, `baseDb`, direct `Pool`, and raw SQL access, including all modules, workers, cron/sync jobs, scripts, tests, and Better Auth.
3. Split operational connection responsibilities where necessary. No worker may gain broad access to tenant business tables just to claim outbox events.
4. Define per-table RLS policies using transaction-local tenant identity. For direct-key tables use `business_id = current_setting('app.business_id', true)::uuid`; for child tables use ownership checks through the parent relation. Missing/empty context must deny access.
5. Design explicit, narrow policies for bootstrap/membership and authentication control-plane operations. Verify trigger functions remain safe: SECURITY DEFINER functions must have a fixed safe search_path, restricted EXECUTE, and no dynamic SQL injection path.
6. Revoke broad runtime grants and grant only required schema/table/sequence/function privileges. Review role memberships, default privileges, ownership, and PUBLIC grants.
7. Add integration tests using two tenants and a reused pool connection: SELECT/INSERT/UPDATE/DELETE isolation; missing context; forged business_id; child-parent mismatch; membership changes; signup/session lookup/logout/password reset; outbox claim/retry/delivery; transaction rollback; worker concurrency.
8. Test the exact Render build and startup against the rehearsal schema with the runtime role. Only after all tests pass may Render `DATABASE_URL` be changed. Keep migration credentials separate via `DATABASE_URL_UNPOOLED` (admin-only) and never print either secret.
9. Run production migrations only after backup/restore readiness and an explicit release window; then switch Render runtime credentials and perform health/auth/business smoke tests.

## Explicit non-actions

- No SQL was executed against the production branch.
- No RLS/grant/role changes were applied to Neon.
- No Render environment variables were read or changed.
- No deployment, merge, or branch creation was performed.
- The rehearsal branch is a current copy, not proof of point-in-time recovery.
