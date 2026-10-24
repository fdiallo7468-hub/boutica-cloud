-- Boutica Cloud: Migration 0001 - Auth Evolution (Business and User Fields)
-- Non-destructive evolution preserving all existing records and references.

ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "phone" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "sector" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "address" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "personal_phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "business_phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "business_sector" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "business_address" text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "business_id" DROP NOT NULL;
