# Boutica Cloud 3.0 — Phase 1: Foundation & Security

**Status:** In progress  
**Baseline:** `main` at `4bfc952820a12fe746e08df8cfbcab3301380f66`  
**Current package version:** `2.1.0`  
**Target:** `3.0.0`

## Product decisions

- Evolve the existing v2.1 backend; do not rewrite it.
- Preserve the existing `/api/v1` business API and `/api/auth` authentication contract unless a versioned compatibility plan is approved.
- Keep the NestJS modular monolith, PostgreSQL, Drizzle ORM and Better Auth.
- Support multiple businesses per user and multiple locations per business.
- Build for multiple African countries from the beginning. Country-specific accounting and tax rules must be versioned configuration packs, not hard-coded assumptions.
- Keep production data and deployments protected throughout development. No production migration, destructive schema push, or automatic production deploy is part of this phase.

## Verified baseline from the repository

- Backend stack: NestJS 11, Better Auth 1.3.4, Drizzle ORM 0.44.5, PostgreSQL via `pg`.
- Existing domains include authentication, business profile, catalog, inventory, sales, purchasing, returns, suppliers, customers, expenses, finance, reports, notifications, storage and sync.
- A `businesses` record currently acts as the tenant boundary.
- `business_members` supports membership across businesses; the current membership role enum is `OWNER | STAFF`.
- The active tenant context currently exposes `userId`, `businessId` and `role`.
- There is no distinct business-location entity in the current schema. Existing sales, purchases, stock and finance records are scoped to `businessId`, not to a branch/location.
- The database schema contains receivables and payments, but the repository does not yet provide a complete general-ledger foundation (chart of accounts, journals, posted balanced entries and accounting periods).
- Migration `0011_repair_business_provisioning_rls.sql` explicitly disables the partial RLS setup because request-scoped tenant identity is not propagated to pooled PostgreSQL connections. Re-enabling RLS before implementing and testing that propagation would risk blocking valid operations without providing complete tenant protection.
- The v2.1 finalization report records that build, unit and E2E commands were not executed in the environment used for that report. Treat that as a historical validation gap; verify current CI and run the commands in a safe test environment before production rollout.

## Phase 1 scope

### 1. Organization and location model

Target hierarchy:

```text
User
  └── Membership(s)
       └── Business / Organization (tenant)
            ├── Business settings and country profile
            ├── Location / Branch A
            │    └── Warehouse(s)
            ├── Location / Branch B
            │    └── Warehouse(s)
            └── Organization-wide reporting
```

Requirements:
- Keep `businessId` as the tenant identifier during the v3 transition.
- Introduce locations as children of a business; never treat a location ID supplied by a client as authorization.
- Define a default location and prevent accidental deletion of locations referenced by transactions.
- Add location scope to operational records only through additive, backfilled migrations with explicit compatibility behavior.
- Preserve the current single-location experience by provisioning a default location for existing businesses.

### 2. Authorization and permissions

- Retain Better Auth as the identity/session provider.
- Separate identity, business membership, role and permission evaluation.
- Define a permission catalogue and role-to-permission matrix before changing existing route behavior.
- Enforce authorization server-side in NestJS guards/services; UI visibility is not authorization.
- Validate membership and resource ownership on every operation.
- Add negative cross-tenant and cross-location tests.
- Do not expand the existing database enum to new roles until all permission checks and migration rollback behavior are designed together.

### 3. Tenant isolation and PostgreSQL RLS

- First inventory every tenant-owned table and every query path.
- Introduce transaction-scoped tenant context using a safe PostgreSQL mechanism compatible with pooled connections.
- Ensure tenant context is set and cleared within the same transaction; never rely on session state that can leak between pooled requests.
- Add RLS policies for all in-scope tenant tables, including safe provisioning paths.
- Keep explicit application-level tenant filters as a second layer of defense.
- Test owner, staff, cross-business access, background jobs, migrations and provisioning before enabling RLS in any shared environment.
- RLS activation must be a separately reviewed migration and must not be bundled with an unrelated feature.

### 4. Audit trail

- Define append-only audit events for security-sensitive and financially meaningful actions.
- Record actor, tenant, optional location, action, resource type/id, timestamp, request/correlation ID and a minimized change summary.
- Do not store passwords, access tokens, payment credentials or unnecessary personal data.
- Audit log access must be restricted and itself auditable.

### 5. Migration safety

- Use additive Drizzle migrations; avoid `db:push` for production.
- Backfill legacy businesses with a default location before making location references mandatory.
- Preserve historical records and existing API response shapes during the compatibility period.
- Validate migration history against a disposable PostgreSQL database and a Neon preview branch.
- Take and verify a restorable backup before any production migration.
- Do not run production migrations or trigger a Render deployment from this branch.

## Phase 1 implementation sequence

1. Add architecture decisions and schema inventory (this document).
2. Produce the tenant-table inventory and permission matrix.
3. Design organization/location schema and migration with a default-location backfill.
4. Implement location APIs with tenant-scoped access and tests.
5. Implement centralized permission checks and negative authorization tests.
6. Implement transaction-scoped tenant context and complete RLS policies.
7. Implement append-only audit trail and tests.
8. Run lint, build, unit tests, PostgreSQL E2E, migration replay and cross-tenant tests.
9. Prepare a reviewed migration and rollout plan; production application remains a separate explicit step.

## Definition of done

- Existing v2.1 behavior remains compatible unless a change is explicitly documented.
- Every business and location resource is tenant-scoped on the server.
- A user cannot read or mutate another business's or unauthorized location's data by changing an ID.
- RLS is enabled only after complete policy coverage and connection-pool isolation tests pass.
- Audit records are append-only and contain no secrets.
- Legacy data is preserved and mapped to a default location.
- CI passes on the feature branch; production remains untouched until separately approved.

## Current safety constraints

- Do not execute `drizzle-kit push` against Neon production.
- Do not run migration `0011` or any new migration in production without confirming the live migration state and reviewing the exact SQL.
- Do not claim runtime tests pass unless they were actually executed and the results are available.
