# Boutica Cloud

NestJS + TypeScript + PostgreSQL (Drizzle ORM) backend for Boutica, a
commerce and inventory management platform for retail merchants. The backend
can be hosted on standard PostgreSQL and Node.js infrastructure; Neon and
Render are optional providers.

This repository contains the **Boutica Cloud 3.0** backend. The v3 scope
adds multi-business and multi-location foundations, commerce operations,
management features, loyalty, and SYSCOHADA accounting through Phase 4.4.
The database is standard PostgreSQL; Neon and Render are optional hosting
providers, not product dependencies. See the
**[self-hosting and transfer guide](./docs/deployment/SELF_HOSTING.md)** for
installation on infrastructure controlled by the operator. Also see:

- **[AUDIT_REPORT.md](./AUDIT_REPORT.md)** — every problem found across all
  four passes, ranked P0–P3, with the reasoning and the fix.
- **[CHANGELOG.md](./CHANGELOG.md)** — what actually changed, file by file.
- **[Phase 4 SYSCOHADA](./docs/PHASE_4_SYSCOHADA.md)** — approved accounting scope and acceptance criteria.

**v2.0 was a breaking change** (auth endpoints moved from
`/api/v1/auth/register` + `/api/v1/auth/login` to Better Auth's own
`/api/auth/sign-up/email` + `/api/auth/sign-in/email` — see
"Authentication" below). **v2.1 is purely additive** — every endpoint that
existed in v2.0 is unchanged; v2.1 only adds new ones and fixes a
cross-tenant reference gap in purchase receiving (see CHANGELOG.md).

## Architecture

```
Presentation (Controllers, DTOs)
        ↓
Application (Use-cases — Sales, Purchasing, Returns)
        ↓
Domain (Money, Quantity, SKU, Sale, Purchase, Return, Stock, Product — no
         NestJS / Drizzle / HTTP imports allowed here)
        ↓
Infrastructure (Drizzle schema, PostgreSQL, DatabaseService)
```

This is deliberately **not** uniform DDD everywhere. Catalog, Customers,
Expenses, Inventory, and Reports stay as thin, validated controllers
directly on top of `DatabaseService` because they don't carry
cross-aggregate invariants that justify a use-case/repository layer. Sales,
Purchasing, and Returns get a full Application layer because that's exactly
where the mission brief's critical rules live: stock concurrency, price
integrity, over-return prevention, and idempotency. See AUDIT_REPORT.md
P2-1 for the full reasoning.

Authentication is a separate concern from the rest of the app: `src/auth/auth.ts`
configures Better Auth directly (not through Nest's DI container — see the
comment at the top of that file for why), and every controller still reads
`@CurrentTenant() tenant: Tenant` exactly as before v2.0 — only *how* that
tenant is resolved changed (`src/modules/auth/current-tenant.decorator.ts`),
so the v2.0 auth migration touched almost none of the domain code.

## Prerequisites

- Node.js 22 LTS
- PostgreSQL 16+
- Chrome/Chromium for Puppeteer PDF generation
- Provider accounts and credentials required by enabled production integrations

**Hosting is provider-neutral:** Neon is one PostgreSQL option and Render is one Node.js hosting option. Neither is required. See the complete [self-hosting and transfer guide](./docs/deployment/SELF_HOSTING.md) for database roles, environment variables, installation, migrations, backup/restore, and transfer acceptance.

## Setup

```bash
npm ci
cp .env.example .env
```

Configure `.env` with the PostgreSQL connection, a unique `BETTER_AUTH_SECRET`,
the actual `BETTER_AUTH_URL`, and the authorized `CORS_ORIGIN` values. In
production, configure the operator's own Arcjet and Cloudinary credentials;
these are currently mandatory integrations. Do not use credentials belonging
to the seller.

Create the database and the `boutica_runtime` / application login roles as
described in [SELF_HOSTING.md](./docs/deployment/SELF_HOSTING.md), then apply
the complete versioned migration history:

```bash
npm run db:migrate
npm run start:dev
```

Use `db:migrate` for fresh databases and every environment that must receive
PostgreSQL triggers, functions, constraints, and other SQL objects not
represented by the Drizzle table schema. In particular, migration
`0010_atomic_user_business_provisioning` installs triggers that provision a
new business, its default activities/modules, the OWNER membership, and
`users.business_id` atomically. Do not replace this migration with
`db:push`.

The API is served with explicit versioned controller paths, e.g.
`http://localhost:3000/api/v1/products`. Swagger docs are at
`http://localhost:3000/docs`. Health check is at `http://localhost:3000/health`.
Better Auth routes live at `/api/auth/*`.

## Authentication

Everything auth-related is handled by [Better Auth](https://better-auth.com),
mounted at `/api/auth/*`. Every OTHER endpoint requires a bearer token:

```bash
curl -X POST http://localhost:3000/api/auth/sign-up/email \
  -H 'Content-Type: application/json' \
  -d '{"name":"Amina","email":"owner@shop.test","password":"a-long-password-123","businessName":"My Shop"}'
# -> { "token": "...", "user": { "id": "...", "businessId": "...", "role": "OWNER", ... } }

curl http://localhost:3000/api/v1/products \
  -H "Authorization: Bearer <token>"
```

Signing up creates a business AND its OWNER user in one call — `businessName`
(and optional `businessCurrency`, `businessPhone`, `businessSector`,
`businessAddress`, and `personalPhone`) are Boutica-specific fields layered
onto Better Auth's normal email/password sign-up. PostgreSQL triggers provision
the business, sector defaults, membership, and active `business_id` as part of
the user-row transaction. If any of those writes fails, PostgreSQL rolls back
the user row and the related business records together. `POST
/api/auth/sign-in/email` with `{email, password}` logs an existing user back
in the same way.

**Password reset:** the mobile app calls `POST /api/auth/request-password-reset`
with the account email and the hosted reset-page URL. Better Auth emails a
single-use link that expires after one hour. The page at `/reset-password`
submits the new password to `POST /api/auth/reset-password`; the new password
must contain at least 10 characters. Configure `RESEND_API_KEY` and a verified
`EMAIL_FROM` address in the production environment for email delivery. Keep
`RESET_PASSWORD_URL` pointed at the backend's `/reset-password` page.

The returned `token` is a Better Auth session token, sent as a normal
bearer token (`Authorization: Bearer <token>`) — this is what the brief's
"JWT for mobile/API" requirement resolves to: one session-based system
Better Auth owns end-to-end, not a second, separate token-signing
mechanism running alongside it. A real, stateless, JWKS-verifiable JWT is
also available (`GET /api/auth/token`, `GET /api/auth/jwks`) for cases that
need a portable credential rather than hitting this database — Boutica's
own API doesn't use that path itself; see `src/auth/auth.ts`.

Every controller reads the tenant via `@CurrentTenant() tenant: Tenant`,
resolved from the verified session — never from the request body. See
AUDIT_REPORT.md P0-1 (why this rule exists at all) and section H (how it's
implemented in v2.0).

**Cross-origin web clients (v2.1):** Better Auth does its own origin/CSRF
validation for cookie-bearing requests, independent of the CORS middleware
in `main.ts`. `src/auth/auth.ts` sets `trustedOrigins` from the same
`CORS_ORIGIN` env var CORS already uses — one list of allowed origins, not
two. This only matters for a browser client (Next.js) sending cookies; it's
a no-op for bearer-token clients (Kotlin, React Native/Expo, Electron), which
never send cookies at all.

## Notifications

Authenticated devices register at `POST /api/v1/notifications/devices` and
remove themselves at `DELETE /api/v1/notifications/devices`. The existing
`push_devices` table remains the source of device tokens and the
`stock_alerts` / `sales_alerts` preferences.

Completed sales and relevant stock transitions are recorded in the additive
PostgreSQL `notification_outbox` table inside the same transaction as the
commercial operation. A background processor retries delivery with
exponential backoff; external notification failures do not roll back sales or
stock changes. Subscriber selection checks both the saved preference and
that the user still belongs to the event's business.

When Novu is configured, it orchestrates the workflows and sends mobile
notifications through a Novu Expo provider integration. Novu subscriber IDs
are the internal Boutica user IDs; only eligible Expo tokens and the
minimum event payload are sent. The verified business ID and name are passed
as the Novu tenant context. The deprecated `@novu/node` SDK has been replaced
by `@novu/api`. Without Novu configuration, the outbox sends through the
existing Expo Push Service path to preserve development and rollout
compatibility.

The initial workflows are `sale.completed`, `inventory.low_stock`, and
`inventory.out_of_stock`. Low-stock notifications are emitted only when
stock crosses from above five units to one through five; stock reaching zero
emits the separate out-of-stock event instead. Replayed sales do not enqueue
duplicate events. Novu's trigger idempotency key combines the durable
outbox event and subscriber ID.

### Novu setup

1. Create a Novu project/environment and an Expo push integration in its
   dashboard. Set the required Expo credentials there; never place them in
   the client or source control.
2. Create and publish three independent workflows with identifiers for
   completed sale, low stock, and out of stock. Add a Push step using the
   Expo provider. Use the trigger payload's `title`, `body`, and `data`
   fields in that step.
3. Configure the following backend-only variables in the local environment
   or Render. The three workflow values must exactly match the identifiers
   in the configured Novu environment:

   ```env
   NOVU_SECRET_KEY=
   NOVU_SERVER_URL=https://api.novu.co
   NOVU_WORKFLOW_SALE_COMPLETED=
   NOVU_WORKFLOW_INVENTORY_LOW_STOCK=
   NOVU_WORKFLOW_INVENTORY_OUT_OF_STOCK=
   ```

   `NOVU_SERVER_URL` is optional for Novu Cloud US (the SDK default).
   `NOVU_APP_IDENTIFIER` is not used by the current server SDK. If a
   `NOVU_SECRET_KEY` is present, all three workflow identifiers are required
   and validated at startup. With no Novu settings, delivery remains on the
   existing Expo path.
4. Apply the new additive migration to a development/test database first.
   For production, validate the Drizzle history and obtain approval before
   applying it; do not use `db:push` or reset Neon.
   The generated migrations are
   `drizzle/0003_secret_tinkerer.sql` and
   `drizzle/0004_clear_landau.sql`.

Web Push, an Electron notification center, and additional event categories
are future provider/workflow extensions; they are not enabled by these
mobile workflows. Notification tests use mocked providers and do not send
real messages:

```bash
npm test -- --runInBand src/modules/notifications src/modules/sales/application/create-sale.usecase.spec.ts
```

## Idempotency

`POST /api/v1/sales`, `POST /api/v1/purchases/receive`, and `POST
/api/v1/returns` accept an optional `Idempotency-Key` header. Retrying the
same request with the same key and the same body replays the original
response instead of creating a second sale/purchase/return. Reusing a key
with a *different* body returns `409 Conflict`. See AUDIT_REPORT.md P0-5.

Not extended to `POST /api/v1/suppliers` or the new `PATCH .../variants/:variantId`
(v2.1): a duplicated supplier row or a repeated identical variant edit
carries none of the stock/money risk a duplicated sale, purchase, or return
does — same reasoning that already applied to `POST /customers` and `POST
/expenses`. Idempotency is reserved for the writes where a duplicate is
actually harmful, not applied uniformly everywhere by default.

## Running the tests

```bash
npm test           # unit tests — no database required
npm run test:cov   # unit tests with coverage
npm run lint       # ESLint
```

The PostgreSQL integration suite exercises the real HTTP layer, Better Auth,
database triggers, tenant isolation, and concurrent offline synchronization.
It truncates its database between tests: **never point it at production or a
database containing data you need**.

For a local PostgreSQL test database, apply the full migration history and
run the suite:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/boutica_test \
BETTER_AUTH_SECRET=<random-test-secret-of-at-least-32-characters> \
BETTER_AUTH_URL=http://localhost:3000 \
CORS_ORIGIN=http://localhost:3000,http://localhost:5173 \
  npm run db:migrate

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/boutica_test \
BETTER_AUTH_SECRET=<same-test-secret> \
BETTER_AUTH_URL=http://localhost:3000 \
CORS_ORIGIN=http://localhost:3000,http://localhost:5173 \
  npm run test:e2e
```

GitHub Actions runs the same migration, lint, unit-test, PostgreSQL e2e, and
TypeScript build checks on pushes to `main` and pull requests. The CI job uses
an ephemeral PostgreSQL 16 service; it does not connect to Neon or production.


## Scripts

| Command | Purpose |
|---|---|
| `npm run start:dev` | Run with hot reload |
| `npm run build` | Compile to `dist/` |
| `npm run lint` | ESLint |
| `npm test` | Unit tests |
| `npm run test:cov` | Unit tests with coverage |
| `npm run test:e2e` | PostgreSQL integration tests (use a disposable database) |
| `npm run db:generate` | Generate SQL migrations from the schema |
| `npm run db:migrate` | Apply migrations |
| `npm run db:push` | Push schema directly (development convenience only; skips SQL migration objects) |

## Domains

Auth (Better Auth) · Catalog (products, variants) · Inventory · Purchasing ·
Suppliers · Sales · Returns · Customers · Expenses · Reports ·
Store/Business — see AUDIT_REPORT.md section D for how each is modeled, and
`BOUTICA_V2_FINALIZATION_REPORT.md` for the full v2.1 endpoint catalog.

## Optional Render deployment example

1. Créer un **Web Service** sur [render.com](https://render.com).
2. Connecter ce dépôt GitHub (`boutica-cloud`).
3. Paramètres du service :
   - **Environment** : Node
   - **Build Command** : `npm install && npm run build`
   - **Start Command** : `npm run start:prod`
   - **Health Check Path** : `/health`
4. Variables d'environnement requises (dans l'onglet *Environment*) :
   - `DATABASE_URL` : URL de connexion PostgreSQL de l'opérateur
   - `BETTER_AUTH_SECRET` : clé aléatoire (32+ caractères)
   - `BETTER_AUTH_URL` : URL publique de l'installation
   - `NODE_ENV=production`
   - `CORS_ORIGIN` : origines HTTPS autorisées du client
   - `ARCJET_KEY` : clé Arcjet active (obligatoire en production)
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`,
     `CLOUDINARY_API_SECRET` : stockage média durable via Cloudinary.
     Le secret API reste exclusivement côté backend.

5. Appliquer toutes les migrations versionnées à la base PostgreSQL cible avant
   de déployer la version applicative qui s'appuie sur ses triggers. Tester
   d'abord sur une base de préproduction. Ne pas utiliser `db:push` pour
   remplacer les migrations SQL.
