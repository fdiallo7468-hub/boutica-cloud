# Boutica Cloud 3.0 — Tenant data inventory

**Baseline:** `main` at `4bfc952820a12fe746e08df8cfbcab3301380f66`  
**Purpose:** identify tenant-owned records before introducing locations, expanded permissions and PostgreSQL RLS.

## 1. Tenant and identity roots

| Table | Scope | Notes |
|---|---|---|
| `businesses` | Tenant root | One business currently represents one tenant. |
| `business_members` | Tenant membership | Joins a user to a business; current roles are OWNER and STAFF. |
| `users` | Identity + active tenant pointer | Has a nullable/current `business_id`; membership remains the authoritative relation for multi-business access. |
| `sessions` | Identity | Better Auth session records; no direct business scope. |
| `accounts` | Identity | Better Auth provider/credential records; no direct business scope. |
| `verifications` | Identity | Better Auth verification records; no direct business scope. |

## 2. Tenant-owned business data

These tables carry a `business_id` and must be included in tenant isolation review and, once safe, RLS policy coverage:

- `business_activities`
- `business_module_configurations`
- `products`
- `variants`
- `device_serials`
- `stock`
- `stock_movements`
- `suppliers`
- `purchases`
- `customers`
- `sales`
- `expenses`
- `returns`
- `idempotency_keys`
- `notification_outbox`
- `push_devices`
- `receivables`
- `payments`
- `payment_cancellations`
- `sync_devices`
- `offline_operations_log`

## 3. Child records without a direct business_id

These records inherit their tenant boundary from a parent record. Their query and RLS design must prevent access through an unrelated parent:

| Table | Parent relation |
|---|---|
| `purchase_items` | `purchase_id` → `purchases` |
| `sale_items` | `sale_id` → `sales` |
| `return_items` | `return_id` → `returns` |

Before RLS is enabled, review all joins, direct lookups and mutation paths for these child tables. Consider adding denormalized tenant keys only where they provide a measurable integrity or policy benefit, and enforce consistency with composite foreign keys or database constraints.

## 4. Known model gaps for v3

1. No separate `business_locations` table exists.
2. Stock balances and stock movements are business-scoped, not warehouse/location-scoped.
3. Sales, purchases, expenses, payments and accounting records do not yet have a consistent location dimension.
4. The current membership role enum is limited to OWNER and STAFF; invitation and fine-grained staff permissions are not fully implemented.
5. The schema has payment and receivable records but does not yet provide a complete double-entry general ledger (account chart, journals, accounting periods, posted balanced entries and statutory reporting).
6. The current tenant decorator resolves one active `businessId` from the Better Auth session. It does not resolve an active location or a permission grant set.
7. Migration `0011_repair_business_provisioning_rls.sql` disables the partial RLS setup. Do not enable RLS table-by-table without a complete tenant-context design and a coverage matrix.

## 5. Required controls before RLS rollout

- [ ] Enumerate every SQL/Drizzle read and write path touching each tenant-owned table.
- [ ] Verify all business IDs are derived from verified membership/session context, never trusted from request payloads.
- [ ] Add cross-business tests for list, read, create, update, delete, nested child records and indirect references.
- [ ] Design transaction-local tenant context for pooled PostgreSQL connections.
- [ ] Test that a connection reused by tenant B cannot retain tenant A context.
- [ ] Cover background jobs, notification workers, provisioning triggers and migration roles.
- [ ] Define safe policies for tenant root and membership tables without creating self-escalation paths.
- [ ] Keep application filters as defense in depth.
- [ ] Test migration replay on an empty disposable PostgreSQL database and an anonymized copy.
- [ ] Only then propose an explicit RLS enablement migration.

## 6. Location migration constraints

- Each existing business must receive exactly one default location during the backfill.
- The backfill must be deterministic and repeatable.
- Existing transactions must remain readable and unchanged.
- A location reference must be validated against the transaction's business.
- Location deletion must be restricted when referenced by business data; use archival/deactivation instead.
- Location IDs received from clients are selectors, not authorization credentials.
