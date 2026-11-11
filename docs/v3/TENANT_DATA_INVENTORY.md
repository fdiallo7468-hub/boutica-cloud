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

## 2A. Additional v3 tenant-owned data (migrations 0012–0019)

The initial inventory above predates the v3 schema additions. The following relations are also tenant-owned and must be included in any RLS/policy rollout:

| Table | Tenant key | Notes |
|---|---|---|
| `business_locations` | `business_id` | Child of the business root; location IDs are never authorization grants. |
| `inventory_balances` | `business_id` | Also constrained by composite business/location and business/variant FKs. |
| `loyalty_configurations` | `business_id` | One configuration per business. |
| `loyalty_ledger` | `business_id` | Append-only; composite customer FK. |
| `audit_events` | `business_id` | Append-only; read access must be restricted and tenant-scoped. |
| `accounting_profiles` | `business_id` | One profile per business. |
| `accounting_accounts` | `business_id` | Self-parent relationship is composite tenant-safe. |
| `accounting_fiscal_years` | `business_id` | Tenant-scoped fiscal periods. |
| `accounting_periods` | `business_id` | Composite FK to fiscal year. |
| `accounting_journals` | `business_id` | Optional location is validated by composite FK. |
| `accounting_entries` | `business_id` | Composite FKs to journal, period and reversal entry. |
| `accounting_entry_lines` | `business_id` | Direct tenant key plus composite FKs to entry, account, customer and supplier. |
| `accounting_event_mappings` | `business_id` | Composite FKs to journal and accounts. |

The existing child tables without their own `business_id` remain:
- `purchase_items` → `purchases`
- `sale_items` → `sales`
- `return_items` → `returns`

### RLS policy design implications

- Direct-key tables can use a transaction-local `app.business_id` policy predicate once every request and worker query is guaranteed to run inside the same tenant transaction.
- Child tables without a direct tenant key require a policy that derives ownership through the parent row, or a deliberate additive denormalized tenant key plus composite FK. Do not create a permissive policy on the child table alone.
- Identity/control-plane tables (`users`, `sessions`, `accounts`, `verifications`, `business_members`) need separate policies and authentication lifecycle analysis; they must not be covered by a blanket `business_id` policy.
- `notification_outbox` requires a worker-specific access design because the worker claims jobs across businesses before it knows which tenant context to establish.
- The v3 migrations 0012–0019 are not present in the currently inspected production branch; the inventory describes the feature-branch target schema, not a production schema assertion.

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
