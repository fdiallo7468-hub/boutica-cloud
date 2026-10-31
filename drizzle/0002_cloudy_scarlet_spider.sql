CREATE TABLE IF NOT EXISTS "push_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"business_id" uuid NOT NULL,
	"stock_alerts" boolean DEFAULT false NOT NULL,
	"sales_alerts" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_devices_token_unique" UNIQUE("token"),
	CONSTRAINT "push_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "push_devices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "business_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "phone" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "sector" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "address" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "image_url" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "business_phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "business_sector" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "business_address" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "personal_phone" text;--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN IF NOT EXISTS "image_url" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_devices_user_idx" ON "push_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_devices_business_idx" ON "push_devices" USING btree ("business_id");
