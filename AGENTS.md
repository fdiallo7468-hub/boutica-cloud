# Boutica Cloud — Project Notes

## Known issue: HTTP 500 on catalog endpoints

**Root cause:** The Drizzle schema (`src/infrastructure/database/schema.ts`) defines `imageUrl: text('image_url')` on both `products` and `variants` tables, but the applied migration (`drizzle/0000_flat_jack_power.sql`) never created those columns. Every `SELECT *` / `.returning()` on those tables fails with `column "image_url" does not exist`, surfacing as HTTP 500 on product listing, product creation, and variant retrieval.

**Fix branch:** `fix/image-url-missing-columns`

**Files changed:**
- `drizzle/0001_add_image_url_to_products_and_variants.sql` — additive `ALTER TABLE ... ADD COLUMN "image_url" text` on both tables
- `drizzle/meta/_journal.json` — registered migration entry idx 1
- `drizzle/meta/0001_snapshot.json` — updated schema snapshot reflecting the two new columns

**Migration status:** Applied to Neon production database (`ep-cool-wildflower-b5dhspar.c-7.us-east-2.aws.neon.tech`). Verified columns present via `\d products` and `\d variants`.

**Build:** `npm run build` passes (TypeScript compiles cleanly).

**Tests:** Verified against production Render API (`https://boutica-cloud.onrender.com`):
- GET /api/v1/products → 200
- POST /api/v1/products → 201
- GET /api/v1/products/:id/variants → 200
- GET /api/v1/variants → 200
- Multi-tenant isolation: PASS (tenant B sees no products from tenant A)

**Deploy:** Render backend operational. No re-deployment needed (uses Neon directly).

**GitHub:** Branch pushed to `fdiallo7468-hub/boutica-cloud`. PR pending creation.
