# Boutica Cloud 3.0 — Self-hosting and transfer guide

**Purpose:** install Boutica Cloud on infrastructure controlled by the buyer/operator.  
**Provider policy:** the application must not depend on the seller's Render, Neon, Cloudinary, Arcjet, email, or notification accounts. Each external integration must use credentials owned by the operator.

## 1. What is being transferred

This repository contains the Boutica Cloud backend (NestJS API, Better Auth integration, PostgreSQL schema and Drizzle migrations). It does not, by itself, transfer the separately maintained Android, desktop, web, or iOS clients. Those repositories and their build/release assets must be listed separately in any complete-product handoff.

The backend is designed for standard PostgreSQL. Neon is one possible PostgreSQL host, not a required database engine. Render is one possible Node.js host, not a required application host.

## 2. Runtime requirements

- Node.js 22 LTS.
- PostgreSQL 16 or later.
- A Linux, macOS, or Windows environment supported by Node.js and the native dependencies.
- A public HTTPS URL for production authentication callbacks and client access.
- Chrome/Chromium available to Puppeteer for PDF generation. The package install lifecycle downloads the Puppeteer-managed Chrome build; where install scripts are disabled, run `npx puppeteer browsers install chrome` explicitly.
- Network access from the API to PostgreSQL and to whichever external providers the operator enables.

No Redis, BullMQ, Neon-specific database extension, or Render-specific runtime is required by the documented backend setup.

## 3. Database provisioning

Use a fresh, dedicated PostgreSQL database for a new installation. Do not use `db:push`; the versioned SQL migration history installs triggers, functions, constraints, indexes, and RLS policies that are not represented by a schema push.

### 3.1 Runtime role

Migration `0020_tenant_row_level_security.sql` grants access to a role named `boutica_runtime`. Create that role before running migrations. The application login should be a separate non-owner role that inherits the runtime grants.

Run as a PostgreSQL administrator, replacing the password and database name:

```sql
CREATE ROLE boutica_runtime
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

CREATE ROLE boutica_app
  LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
  PASSWORD 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';

GRANT boutica_runtime TO boutica_app;
GRANT CONNECT ON DATABASE boutica TO boutica_app;
```

The migration account must own the application schema/tables it creates (or otherwise have the privileges required to create and alter them). Run migrations with that separate owner/migration credential. Do not use a superuser or table-owner credential as the long-running API login.

Migration `0020` sets default privileges for the role executing the migration. Future migrations must be run by the same migration owner, or their ownership/default privileges must be explicitly reviewed.

### 3.2 Connection strings

- `DATABASE_URL`: application runtime connection using `boutica_app`.
- `DATABASE_URL_UNPOOLED`: optional direct connection used only by Drizzle migrations when the runtime URL points to a connection pooler. Omit it for a standard direct PostgreSQL connection.
- Never expose the migration-owner credential to the API process.

For a non-pooled PostgreSQL server, `DATABASE_URL` can be used by both the API and the migration command during initial setup, provided the migration command is run with the migration owner's environment rather than the restricted runtime login.

## 4. Environment configuration

Copy `.env.example` to `.env`. At minimum, production requires:

| Variable | Purpose |
|---|---|
| `NODE_ENV=production` | Enables production validation and security behavior |
| `PORT` | HTTP listen port; defaults to 3000 |
| `DATABASE_URL` | PostgreSQL runtime connection |
| `BETTER_AUTH_SECRET` | Unique random secret, at least 32 characters |
| `BETTER_AUTH_URL` | Public base URL of this installation |
| `CORS_ORIGIN` | Comma-separated HTTPS origins of authorized browser clients |
| `ARCJET_KEY` | Operator-owned Arcjet key; currently mandatory in production |
| `CLOUDINARY_CLOUD_NAME` | Operator-owned Cloudinary account |
| `CLOUDINARY_API_KEY` | Operator-owned Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Operator-owned Cloudinary API secret |

Generate an authentication secret with:

```bash
openssl rand -base64 48
```

### External integrations

- **Arcjet:** currently mandatory in production. The production API refuses to start without an operator-provided key.
- **Cloudinary:** currently the implemented durable media provider and mandatory in production. Media upload/download routes depend on it.
- **Resend:** optional; required only if password-reset email delivery is enabled. When enabled, set `EMAIL_FROM` to a sender address on a domain verified in the buyer's own Resend account; the example address is only a placeholder.
- **Novu:** optional; used only when the operator configures its API key and workflow identifiers. Without it, the existing Expo delivery path is used.
- **Expo Push:** used by the direct push-notification path when Novu is not configured.

These are provider integrations, not seller-owned infrastructure. The buyer must create and control the accounts and credentials used by their installation. Replacing Arcjet or Cloudinary with self-hosted or alternative providers is a separate engineering scope; the current implementation is not provider-agnostic for those two services.

## 5. Install and migrate

From the backend repository root:

```bash
npm ci
cp .env.example .env
# Edit .env with the operator's own database and service credentials.

npm run db:migrate
npm run lint
npm test -- --runInBand
npm run build
npm run start:prod
```

For PostgreSQL integration tests, use a separate disposable database only:

```bash
NODE_OPTIONS=--experimental-vm-modules npm run test:e2e -- --runInBand
```

**Warning:** the E2E suite truncates tables. Never point it at production or at a database containing data that must be retained.

The first business owner is created through Better Auth email signup. The signup payload must include the required `businessName`; PostgreSQL provisioning triggers create the business and its initial membership atomically.

## 6. Health check and operational commands

- Health endpoint: `GET /health`.
- API documentation: `/docs`.
- Production start command: `npm run start:prod`.
- Migration command: `npm run db:migrate`.
- Build command: `npm run build`.

Use the hosting platform's process manager or service supervisor to restart the API after failure and to deliver SIGTERM/SIGINT so NestJS can close PostgreSQL pools cleanly.

## 7. Backup, upgrade, and recovery

Before every production migration:

1. Take a PostgreSQL backup or provider snapshot.
2. Verify that the backup can be restored to a separate database.
3. Review the ordered SQL migration files and the Drizzle migration ledger.
4. Apply migrations using the migration-owner credential.
5. Run health, authentication, tenant-isolation, sales, inventory, and accounting smoke tests.
6. Record the application commit and migration IDs.

Migrations are additive by design. Do not edit already-applied migration files in an installation; add a new migration for subsequent schema changes.

## 8. Transfer acceptance checklist

A transfer is not technically accepted until all of the following are demonstrated on infrastructure that does not belong to the seller:

- [ ] A clean PostgreSQL database can be provisioned without Neon.
- [ ] The complete migration history replays successfully from an empty database.
- [ ] The API starts without Render environment variables, hostnames, or service IDs.
- [ ] The API uses the buyer's own runtime database credentials, not the migration owner.
- [ ] Signup, login, session lookup, password reset configuration, and logout work.
- [ ] Two businesses can be created and tenant data remains isolated under the actual runtime login.
- [ ] Media upload/download works with the buyer's own configured storage account.
- [ ] PDF generation works with the installed Chrome runtime.
- [ ] Lint, unit tests, PostgreSQL E2E tests, and production build pass.
- [ ] The buyer can back up, restore, upgrade, and restart the installation using the documentation.
- [ ] All separately maintained client repositories, assets, signing/build credentials, and third-party licenses included in the sale are explicitly inventoried.

## 9. Current security limitation — do not skip

The current Better Auth and NestJS application use separate PostgreSQL pools but the same `DATABASE_URL`. Identity tables (`users`, `accounts`, `sessions`, and `verifications`) are intentionally outside tenant RLS; migration `0020` grants the runtime role the CRUD permissions Better Auth requires. Tenant tables are protected by RLS policies for `boutica_runtime`.

The existing RLS E2E suite explicitly switches to `boutica_runtime` for selected negative tests. Before calling an installation or transfer production-ready, the complete HTTP authentication and tenant-isolation suite must also be exercised through the actual `boutica_app` login role on a clean PostgreSQL installation. The auth control-plane boundary and all non-HTTP workers must remain part of the final security review.
