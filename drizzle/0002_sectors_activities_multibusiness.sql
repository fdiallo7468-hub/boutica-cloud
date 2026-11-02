-- Boutica Cloud: Migration 0002 - Dual Sectors (Quincaillerie & Électronique), Modular Activities, Multi-Business Members, and Traceability
-- Fully non-destructive, idempotent, and backwards-compatible with Boutica Desktop.

-- 1. Ensure businesses.sector default
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "sector" text DEFAULT 'QUINCAILLERIE';
--> statement-breakpoint
UPDATE "businesses" SET "sector" = 'QUINCAILLERIE' WHERE "sector" IS NULL OR "sector" = '';
--> statement-breakpoint
ALTER TABLE "businesses" ALTER COLUMN "sector" SET DEFAULT 'QUINCAILLERIE';
--> statement-breakpoint

-- 2. Business Activities Table (Multi-activity support per business)
CREATE TABLE IF NOT EXISTS "business_activities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "activity" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_activities_business_activity_unique" ON "business_activities" ("business_id", "activity");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_activities_business_idx" ON "business_activities" ("business_id");
--> statement-breakpoint

-- 3. Business Module Configurations Table (Dynamic modules like IMEI, Serial, Warranty, Units)
CREATE TABLE IF NOT EXISTS "business_module_configurations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "module" text NOT NULL,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_modules_business_module_unique" ON "business_module_configurations" ("business_id", "module");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_modules_business_idx" ON "business_module_configurations" ("business_id");
--> statement-breakpoint

-- 4. Multi-business Membership Table
CREATE TABLE IF NOT EXISTS "business_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" "user_role" NOT NULL DEFAULT 'OWNER',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_members_unique" ON "business_members" ("business_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_members_user_idx" ON "business_members" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_members_business_idx" ON "business_members" ("business_id");
--> statement-breakpoint

-- 5. Specialized Variant Columns (Traceability & Units)
ALTER TABLE "variants" ADD COLUMN IF NOT EXISTS "unit" text;
--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN IF NOT EXISTS "has_serial" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN IF NOT EXISTS "has_imei" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN IF NOT EXISTS "warranty_months" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- 6. Device Serials & IMEI Tracking (Électronique & High-value hardware items)
CREATE TABLE IF NOT EXISTS "device_serials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "variant_id" uuid NOT NULL REFERENCES "variants"("id") ON DELETE CASCADE,
  "serial_number" text,
  "imei" text,
  "status" text NOT NULL DEFAULT 'IN_STOCK',
  "warranty_months" integer NOT NULL DEFAULT 0,
  "sale_item_id" uuid,
  "sold_at" timestamp with time zone,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_serials_business_idx" ON "device_serials" ("business_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_serials_variant_idx" ON "device_serials" ("variant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_serials_business_serial_unique" ON "device_serials" ("business_id", "serial_number") WHERE "serial_number" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_serials_business_imei_unique" ON "device_serials" ("business_id", "imei") WHERE "imei" IS NOT NULL;
--> statement-breakpoint

-- 7. Data Backfill for Existing Businesses (Quincaillerie)
-- Backfill activities for existing businesses (default: CONSTRUCTION_MATERIALS, GENERAL_HARDWARE)
INSERT INTO "business_activities" ("business_id", "activity", "is_active")
SELECT b.id, 'CONSTRUCTION_MATERIALS', true
FROM "businesses" b
ON CONFLICT ("business_id", "activity") DO NOTHING;
--> statement-breakpoint
INSERT INTO "business_activities" ("business_id", "activity", "is_active")
SELECT b.id, 'GENERAL_HARDWARE', true
FROM "businesses" b
ON CONFLICT ("business_id", "activity") DO NOTHING;
--> statement-breakpoint

-- Backfill default modules for existing businesses (MEASUREMENT_UNITS, UNIT_CONVERSIONS)
INSERT INTO "business_module_configurations" ("business_id", "module", "is_enabled")
SELECT b.id, 'MEASUREMENT_UNITS', true
FROM "businesses" b
ON CONFLICT ("business_id", "module") DO NOTHING;
--> statement-breakpoint
INSERT INTO "business_module_configurations" ("business_id", "module", "is_enabled")
SELECT b.id, 'UNIT_CONVERSIONS', true
FROM "businesses" b
ON CONFLICT ("business_id", "module") DO NOTHING;
--> statement-breakpoint

-- Backfill business_members from existing users.business_id
INSERT INTO "business_members" ("business_id", "user_id", "role")
SELECT u.business_id, u.id, COALESCE(u.role, 'OWNER'::user_role)
FROM "users" u
WHERE u.business_id IS NOT NULL
ON CONFLICT ("business_id", "user_id") DO NOTHING;
