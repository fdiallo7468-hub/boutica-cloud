# Buyer infrastructure handoff — Boutica Cloud 3.0

## Objective

After a full sale, the buyer must be able to operate Boutica Cloud using infrastructure accounts, domains, credentials, storage and deployment pipelines controlled by the buyer. No production workload should depend on the seller's personal, Fluo or Saora accounts.

This document describes the required handoff. It does not authorize deletion, revocation, migration or disconnection of the seller's live resources.

## Portability status

| Layer | Current implementation | Buyer handoff requirement | Portability gap |
|---|---|---|---|
| API hosting | NestJS application; current Render service follows main with auto-deploy | Buyer-owned Render, VPS or other Node.js hosting account | No Render deploy workflow is committed; the current Render auto-deploy is configured outside this repository |
| Database | PostgreSQL via DATABASE_URL; Drizzle migrations | Buyer-owned PostgreSQL 16+ database and separate migration credential | PostgreSQL is portable; backup/restore rehearsal is still required |
| Migration connection | DATABASE_MIGRATION_URL (preferred), legacy DATABASE_URL_UNPOOLED alias | Direct PostgreSQL connection available only to migration runner | API runtime must not receive the migration credential |
| Authentication | Better Auth + PostgreSQL | New buyer-owned BETTER_AUTH_SECRET, public BETTER_AUTH_URL, exact CORS_ORIGIN | Existing sessions/password-reset tokens should not be assumed portable; plan user/session migration deliberately |
| Media | StorageService directly calls Cloudinary REST API | New Cloudinary account owned by buyer, or implement and test another storage adapter before transfer | Cloudinary-specific implementation remains; S3/R2 adapter is not implemented |
| WAF / abuse protection | Arcjet guard; ARCJET_KEY required in production | Buyer-owned Arcjet workspace and key, or a separately reviewed replacement guard | Arcjet-specific integration remains |
| Email | Resend API called directly; RESEND_API_KEY and EMAIL_FROM | Buyer-owned email provider account and verified sender/domain | Resend-specific integration remains |
| Notifications | PostgreSQL outbox; optional Novu integration | Buyer-owned Novu account only if workflows are enabled; otherwise use documented direct push path | External workflows and Expo credentials require separate transfer/recreation |
| CI | GitHub Actions CI only | Repository under buyer-controlled GitHub organization with buyer-owned secrets and permissions | No repository-specific deployment workflow is currently defined |
| Domain / DNS | Runtime URL and CORS are environment-driven | Buyer-owned domain, DNS, TLS and callback URLs | Seller's domain must not be assumed to transfer automatically |
| Secrets | Environment variables | Generate new production secrets and rotate provider keys | Never copy seller secrets into buyer production |

## Required buyer environment

### API runtime

- NODE_ENV=production
- PORT supplied by the hosting platform
- DATABASE_URL for the least-privileged runtime PostgreSQL role
- BETTER_AUTH_SECRET newly generated for the buyer installation (at least 32 high-entropy characters)
- BETTER_AUTH_URL set to the buyer's public API URL
- CORS_ORIGIN set to the exact HTTPS client origins
- ARCJET_KEY from the buyer's Arcjet account
- CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET from the buyer's Cloudinary account
- RESEND_API_KEY, EMAIL_FROM, RESET_PASSWORD_URL if password-reset email is enabled
- Novu keys/workflow IDs only if the buyer configures the corresponding workflows

### Migration runner only

- DATABASE_MIGRATION_URL: direct PostgreSQL connection with the migration privileges needed by the reviewed migration set.
- Do not expose this variable to the long-running API process.
- DATABASE_URL_UNPOOLED is retained only as a legacy alias during transition.

## Cutover sequence

1. Create the buyer's GitHub organization/repository or transfer the repository after IP/contributor-rights clearance.
2. Create buyer-owned hosting, PostgreSQL, media storage, WAF, email and notification accounts as required.
3. Provision the database from the reviewed migration baseline; apply migrations only after a tested backup and restore procedure.
4. Configure buyer-generated secrets and exact public URLs. Do not copy seller secrets.
5. Deploy to a staging environment and run health, authentication, tenant-isolation, sales, purchase, stock, payment, media upload/download, email and accounting smoke tests.
6. Export and transfer business data and media under an agreed data-processing/ownership plan; verify row counts, checksums and media references.
7. Switch DNS/client configuration only after staging acceptance and rollback readiness.
8. Verify the buyer's production environment and backup schedule.
9. Only after acceptance and payment, revoke seller-side credentials, remove seller webhooks/deploy integrations and retire old infrastructure according to the signed transfer agreement.

## Mandatory pre-merge protection

The current Render service is configured outside GitHub to auto-deploy commits on main. A merge of PR #5 can therefore deploy to the seller's existing Render service. Before merging, either:
- detach/disable that auto-deploy integration in the seller's Render account, or
- retarget the existing service to a neutral handoff branch that cannot receive the merge.

Do not delete the service, database, storage bucket/cloud account, snapshots or media during this step. Preserve the existing environment until the buyer has validated the replacement and the transfer agreement authorizes retirement.

## Acceptance gate

The buyer must be able to deploy the API, apply reviewed migrations, restore a database backup, upload/download media and operate the product without access to the seller's accounts or secrets. This handoff document is not evidence that a live cutover has occurred.
