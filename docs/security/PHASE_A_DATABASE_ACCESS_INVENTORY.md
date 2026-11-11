# Phase A — PostgreSQL access inventory

**Scope:** Boutica Cloud 3.0 feature branch and Neon rehearsal branch only.  
**Status:** source/schema inventory completed for the currently inspected paths; release audit remains open until every raw client/callsite and auth boundary is tested.

## Database connection paths

| Path | Implementation | Security consequence |
|---|---|---|
| Main application | `DatabaseService` owns a shared `pg.Pool` (max 10) and Drizzle `baseDb`. | `db` resolves the request-local transaction when present, otherwise falls back to `baseDb`. Under RLS, tenant tables must fail closed without context. |
| HTTP tenant requests | `TenantDatabaseInterceptor` resolves Better Auth session, then persisted `business_members` membership, then calls `TenantTransactionService.run`. | The session's active business is only a selector; persisted membership is rechecked before tenant context is established. |
| Tenant transaction | `TenantTransactionService.run` starts a transaction and sets `app.business_id`, `app.actor_user_id`, and `app.request_id` transaction-locally. | Context is connection-safe and cleared at transaction end; never replace `set_config(..., true)` with session-scoped state. |
| Better Auth | `src/auth/auth.ts` owns a second `pg.Pool` (max 5) using the same `DATABASE_URL`. | Session resolution and sign-up occur before an HTTP tenant context exists. Identity tables are therefore explicitly excluded from tenant RLS until a dedicated auth DB role/connection is implemented. |
| Business bootstrap | Onboarding and additional-business routes use explicit `baseDb.transaction` calls. | They set actor and pre-generate/set business UUID before inserting the tenant root, so the business INSERT/RETURNING policy can be satisfied. |
| Notification worker | `NotificationOutboxWorker` claims a bounded cross-tenant batch through `boutica_claim_notification_outbox`, then loads and updates each event inside `TenantTransactionService.run`. | The worker no longer scans or updates tenant rows directly without context. The claim function is the intentionally narrow cross-tenant entry point. |
| Audit writer | `AuditEventsService.appendInTransaction` receives a transaction; `append` accepts a caller-supplied `PoolClient`. | All callers of the raw-client overload must be checked to ensure the client transaction has tenant context. |
| Tests | E2E helpers use the test database owner; the RLS suite explicitly executes `SET LOCAL ROLE boutica_runtime`. | Ordinary owner-based E2E tests alone do not prove RLS enforcement. |

## Rehearsal database facts

- Neon project: `late-flower-80953903`.
- Rehearsal branch: `br-proud-flower-b5tpo59z`; it is a recent production copy, not a PITR restore test.
- Current inspected schema: 43 tables in `public`.
- Before applying migration 0020, `pg_policies` returned no policies and RLS was disabled on the 43 public tables.
- `boutica_runtime`: LOGIN, NOSUPERUSER, NOBYPASSRLS, no role memberships.
- `neondb_owner`: LOGIN, NOCREATEROLE=false, BYPASSRLS=true; it is a member of `boutica_runtime`. It remains an administrative/migration role and is not an acceptable application runtime identity.
- `boutica_runtime` had broad table grants; default privileges from `neondb_owner` also granted broad CRUD on future tables and sequence access. Migration 0020 revokes those defaults and re-grants explicit table privileges.
- Provisioning and default-location trigger functions are SECURITY DEFINER with a fixed search path and PUBLIC EXECUTE revoked. Their ownership and grants remain part of the ongoing review.

## Table classification

### Tenant/business data — RLS target (39 tables)

`accounting_accounts`, `accounting_entries`, `accounting_entry_lines`, `accounting_event_mappings`, `accounting_fiscal_years`, `accounting_journals`, `accounting_periods`, `accounting_profiles`, `audit_events`, `business_activities`, `business_locations`, `business_members`, `business_module_configurations`, `businesses`, `customers`, `device_serials`, `expenses`, `idempotency_keys`, `inventory_balances`, `loyalty_configurations`, `loyalty_ledger`, `notification_outbox`, `offline_operations_log`, `payment_cancellations`, `payments`, `products`, `purchase_items`, `purchases`, `push_devices`, `receivables`, `return_items`, `returns`, `sale_items`, `sales`, `stock`, `stock_movements`, `suppliers`, `sync_devices`, `variants`.

### Authentication control plane — excluded from tenant RLS (4 tables)

- `users`
- `accounts` (Better Auth credentials/tokens)
- `sessions`
- `verifications`

This is a deliberate compatibility exception, not a claim that these tables are least-privileged. Because Better Auth and the application currently share the same runtime URL, a separate `boutica_auth` role/connection and corresponding grants are still required before the production role switch. Do not enable RLS on these four tables until sign-in, session lookup, signup, password reset, and session revocation are tested using that dedicated auth connection.

## Non-HTTP and raw access review

- The old outbox worker performed direct global table scans/updates. It has been changed to a bounded SECURITY DEFINER claim function plus per-business transactions.
- `NotificationOutboxProcessor` is not registered in `NotificationsModule`; it remains an alternate implementation and must not be activated without its own tests.
- `DatabaseService.db` fallback to `baseDb` is retained for health/control-plane and explicit non-tenant operations. Tenant table access from those paths must be denied by RLS unless the operation is an explicitly reviewed function.
- `AuditEventsService.append(PoolClient, ...)` requires a callsite audit. The transaction overload is preferred.
- No production Neon SQL, Render environment change, merge, or deployment was performed.

## Remaining Phase A gates

1. Search every repository source/test/script for direct `Pool`, `PoolClient`, `baseDb`, `$client`, raw SQL and direct database imports; record each callsite and its transaction boundary.
2. Decide and implement the dedicated Better Auth DB role/connection before applying tenant RLS to identity tables or switching Render.
3. Review every SECURITY DEFINER function, owner, safe search path, EXECUTE ACL and any trigger dependencies.
4. Review all FK relationships not backed by composite tenant keys; RLS policies must independently reject cross-tenant references where needed.
5. Validate the inventory against the final branch HEAD and the rehearsal database after migration 0020.
