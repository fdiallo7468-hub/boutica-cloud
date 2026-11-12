# Phase B — RLS policy matrix

**Migration:** `0020_tenant_row_level_security.sql`  
**Status:** implemented on `feat/boutica-cloud-v3-foundation`; not yet applied/validated on the Neon rehearsal branch.

## Context contract

- `app.business_id`: verified active business UUID.
- `app.actor_user_id`: authenticated user ID.
- `app.request_id`: request correlation ID.
- Context is established only after Better Auth session resolution and a persisted membership check.
- Context must be set transaction-locally with `set_config(name, value, true)`.
- Missing/empty business context must produce no tenant rows and reject tenant writes.

## Policy groups

| Group | Tables | Rule |
|---|---|---|
| Direct tenant key | All business tables with `business_id`, including accounting, sales, purchases, inventory (including CUMP valuations), finance, loyalty and operations | `business_id = boutica_current_business_id()` for USING and WITH CHECK. RLS enabled and forced. |
| Tenant root | `businesses` | SELECT active business or businesses with a membership for the actor; INSERT requires actor and preassigned current business ID; UPDATE is active-business only; no DELETE policy. |
| Membership control plane | `business_members` | SELECT own memberships across businesses or all memberships in active business; INSERT is restricted to actor's own OWNER membership in active business; no UPDATE/DELETE policy. |
| Child through parent | `sale_items`, `purchase_items`, `return_items` | Access requires a visible parent row; additional restrictive policies verify same-tenant variant and coherent return/sale-item relationships. |
| Cross-tenant references | Sales, purchases, returns, payments, receivables, stock, stock movements, CUMP inventory valuations, serials, cancellations, loyalty, audit, push and sync devices | Restrictive policies validate referenced records or membership belong to the same business. |
| Transactional outbox | `notification_outbox` | Tenant-scoped SELECT/INSERT/UPDATE; cross-tenant claim only through a bounded SECURITY DEFINER function; per-row reads/updates use tenant transactions. |
| Append-only ledgers | `audit_events`, `loyalty_ledger` | Tenant-scoped SELECT/INSERT only; no UPDATE/DELETE policy; audit SELECT is restricted to the generated ID column needed by INSERT RETURNING. |
| Authentication control plane | `users`, `accounts`, `sessions`, `verifications` | Excluded pending dedicated auth connection/role; this remains a production release gate. |

## Required validation

1. Fresh PostgreSQL 16 migration replay, including the exact Drizzle journal checksum.
2. Confirm RLS enabled/forced and policies present on all 40 target tables.
3. Verify the runtime role is NOBYPASSRLS and has no unintended role memberships.
4. Two-business tests for SELECT, INSERT, UPDATE, DELETE, missing context, forged business IDs and child-row mismatch.
5. Tests for business switching/listing, onboarding, additional business provisioning and membership revocation.
6. Outbox claim/retry/delivery tests across businesses and concurrent workers.
7. Verify default privileges do not silently grant CRUD/sequence rights to runtime for future objects.
8. Verify no test or app runtime uses the BYPASSRLS owner role.

Migration 0020 is not production approval. Do not switch Render's DATABASE_URL until all Phase A/B/C gates, including the auth connection split, are complete.
