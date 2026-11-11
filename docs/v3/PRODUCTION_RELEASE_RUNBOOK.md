# Boutica Cloud 3.0 — Production release runbook

**Target:** Render workspace Fluo + Neon project `boutica`  
**Release state:** preparation only; production migration, PR merge and deploy are not authorized by this document.

## 1. Current infrastructure baseline (observed 2026-11-11)

### Render
- Workspace: Fluo (`tea-db2f5gjncjis73egf4og`)
- Service: `boutica-cloud` (`srv-db8c5uavcj2c738vgqrg`)
- Repository: `fdiallo7468-hub/boutica-cloud`
- Tracked branch: `main`
- Auto-deploy: enabled on commit; merging PR #5 will trigger a deployment.
- Plan: Free; region: Oregon.
- Public URL: `https://boutica-cloud.onrender.com`
- Health endpoint: `GET /health`; it executes `SELECT 1` and returns non-2xx if PostgreSQL is unavailable.

### Neon
- Project: `late-flower-80953903` (`boutica`)
- Production/default branch: `br-lucky-union-b5cqpuuo` (`production`)
- Production migration ledger: entries 1–11.
- v3 migrations 0012–0019 are not applied to production.
- Current point-in-time branch copy: `pre-v3-production-2026-11-11` (`br-red-rain-b5ddfjir`), created from production at 2026-11-11T12:35:48Z, no compute enabled.
- Historical restore drill: `restore-rehearsal-2026-11-11` (`br-solitary-recipe-b53v6awr`), restored from the existing 2026-10-23 snapshot. This is not a current recovery point.

## 2. Runtime and migration connection separation

- `DATABASE_URL`: API runtime connection. Use the least-privileged `boutica_runtime` role and the pooled Neon endpoint where appropriate.
- `DATABASE_URL_UNPOOLED`: direct Neon connection for Drizzle migration tooling only. The repository's `drizzle.config.ts` prefers this variable and rejects a hostname containing `-pooler`.
- Never put the database owner/migration credential in the API runtime environment. Use a secure one-time migration runner/operator environment. Do not commit connection strings or credentials.
- Do not use `drizzle-kit push` in production. Use the reviewed, ordered migration journal with `npm run db:migrate`.

## 3. Required Render runtime environment

Confirm these keys exist and validate values without printing secrets:
- `NODE_ENV=production`
- `PORT` (Render-provided)
- `DATABASE_URL` (runtime role; production Neon branch)
- `BETTER_AUTH_SECRET` (unique, high-entropy, at least 32 characters)
- `BETTER_AUTH_URL=https://boutica-cloud.onrender.com`
- `CORS_ORIGIN` (explicit HTTPS origins for the real clients; do not guess or use `*`)
- `ARCJET_KEY`
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`

Optional integrations must only be configured when their credentials and workflows are actually enabled: Novu, Resend, and email reset URLs. Do not add `DATABASE_URL_UNPOOLED` to the API runtime service.

## 4. Migration and deployment order

1. Complete the tenant request/worker transaction-context implementation and the RLS table/policy inventory. Do not enable partial RLS.
2. Complete audit event coverage, audit read restrictions, role/default-privilege review, pool-isolation tests and negative cross-tenant E2E tests.
3. Confirm a current Neon recovery point and test restoration. The current branch copy is a pre-release recovery branch; the existing snapshot restore drill used an older snapshot. Neon rejected a new manual snapshot because the project's snapshot limit was exceeded. Do not delete existing snapshots to work around this without explicit approval.
4. Verify the production migration plan against the exact current production journal (1–11). Test migrations 0012–0019 against a clone before production application.
5. Apply only reviewed additive migrations using a direct connection in a secure migration environment. Verify the migration ledger and critical row counts.
6. Deploy the tested v3 application. Because Render currently auto-deploys on every commit to `main`, merging PR #5 will trigger the deploy. Ensure the database is at the compatible schema level before the merge.
7. After the v3 app is live and request/worker transaction context is confirmed, enable the complete RLS migration as a separate controlled database change, then run cross-tenant smoke tests.
8. Verify Render deployment status, `GET /health`, API auth, sales, purchases, inventory, payments, reports, accounting ledger and logs. Confirm no unexpected 4xx/5xx or migration errors.

## 5. Render plan limitation

The existing service is on the Free plan. Do not assume a paid-plan pre-deploy command is available. Until a dedicated migration runner is configured, execute database migrations separately through a secure operator workflow. Do not place an owner credential in the long-running API service just to automate migrations.

## 6. Rollback

- Application rollback: redeploy the last known-good Render commit.
- Database rollback: do not reverse additive production migrations with ad-hoc SQL. Use the verified Neon recovery branch/PITR procedure after assessing writes since the recovery point. A rollback plan must account for new application writes and cannot be reduced to simply switching branches.
- Record the release commit, migration IDs, Neon branch ID, Render deploy ID and post-deploy smoke-test results.

## 7. Release gate

PR #5 must not merge while full RLS propagation, complete tenant-owned table/worker coverage, audit read grants, production backup policy and restoration proof remain open. CI green alone is not production security approval.
