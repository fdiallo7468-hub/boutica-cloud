-- Boutica Cloud: Relax constraints to accept uppercase and finance outbox events
ALTER TABLE "notification_outbox" DROP CONSTRAINT IF EXISTS "notification_outbox_event_type_valid";
--> statement-breakpoint
ALTER TABLE "notification_outbox" DROP CONSTRAINT IF EXISTS "notification_outbox_status_valid";
--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_status_valid" CHECK ("notification_outbox"."status" IN ('pending', 'processing', 'delivered', 'failed', 'PENDING', 'PROCESSING', 'DELIVERED', 'FAILED'));
--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_event_type_valid" CHECK ("notification_outbox"."event_type" IN ('sale.completed', 'inventory.low_stock', 'inventory.out_of_stock', 'finance.receivable_created', 'finance.payment_received'));
--> statement-breakpoint
-- Boutica Cloud: Migration 0003 - Notification Outbox (Novu), Receivables & Payments, Offline Sync Engine
-- Fully non-destructive, idempotent, and backward-compatible.

-- 1. Notification Outbox (Ensures table and indexes are aligned)
CREATE TABLE IF NOT EXISTS "notification_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "deduplication_key" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'PENDING',
  "attempts" integer NOT NULL DEFAULT 0,
  "available_at" timestamp with time zone NOT NULL DEFAULT now(),
  "locked_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_outbox_dedup_idx" ON "notification_outbox" ("deduplication_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_outbox_status_idx" ON "notification_outbox" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_outbox_available_at_idx" ON "notification_outbox" ("available_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_outbox_business_idx" ON "notification_outbox" ("business_id");
--> statement-breakpoint

-- 2. Push Devices (Mobile and Desktop push registration)
CREATE TABLE IF NOT EXISTS "push_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "token" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "stock_alerts" boolean NOT NULL DEFAULT true,
  "sales_alerts" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_devices_business_idx" ON "push_devices" ("business_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_devices_user_idx" ON "push_devices" ("user_id");
--> statement-breakpoint

-- 3. Receivables Table (Créances clients liées aux ventes avec échéances et soldes)
CREATE TABLE IF NOT EXISTS "receivables" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id"),
  "sale_id" uuid NOT NULL REFERENCES "sales"("id") ON DELETE CASCADE,
  "initial_amount" numeric(14, 2) NOT NULL,
  "paid_amount" numeric(14, 2) NOT NULL DEFAULT '0',
  "remaining_balance" numeric(14, 2) NOT NULL,
  "due_date" timestamp with time zone,
  "status" text NOT NULL DEFAULT 'PENDING',
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "receivables_business_idx" ON "receivables" ("business_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "receivables_customer_idx" ON "receivables" ("customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "receivables_sale_idx" ON "receivables" ("sale_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "receivables_status_idx" ON "receivables" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "receivables_due_date_idx" ON "receivables" ("due_date");
--> statement-breakpoint

-- 4. Payments Table (Règlements indépendants avec reçus et traçabilité)
CREATE TABLE IF NOT EXISTS "payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id"),
  "sale_id" uuid REFERENCES "sales"("id"),
  "receivable_id" uuid REFERENCES "receivables"("id"),
  "amount" numeric(14, 2) NOT NULL,
  "payment_method" text NOT NULL DEFAULT 'CASH',
  "transaction_reference" text,
  "recorded_by" text REFERENCES "users"("id"),
  "status" text NOT NULL DEFAULT 'CONFIRMED',
  "receipt_number" text NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_business_idx" ON "payments" ("business_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_customer_idx" ON "payments" ("customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_sale_idx" ON "payments" ("sale_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_receivable_idx" ON "payments" ("receivable_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_status_idx" ON "payments" ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payments_receipt_number_unique" ON "payments" ("business_id", "receipt_number");
--> statement-breakpoint

-- 5. Payment Cancellations Table (Contrepassation et journal d'audit)
CREATE TABLE IF NOT EXISTS "payment_cancellations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "payment_id" uuid NOT NULL REFERENCES "payments"("id") ON DELETE CASCADE,
  "cancelled_by" text NOT NULL REFERENCES "users"("id"),
  "reason" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_cancellations_business_idx" ON "payment_cancellations" ("business_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_cancellations_payment_idx" ON "payment_cancellations" ("payment_id");
--> statement-breakpoint

-- 6. Sync Devices Table (Enregistrement et état de synchronisation des clients Desktop / Mobile)
CREATE TABLE IF NOT EXISTS "sync_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "device_id" text NOT NULL,
  "device_type" text NOT NULL DEFAULT 'DESKTOP',
  "device_name" text,
  "app_version" text,
  "last_sync_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sync_devices_scope_unique" ON "sync_devices" ("business_id", "device_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_devices_business_idx" ON "sync_devices" ("business_id");
--> statement-breakpoint

-- 7. Offline Operations Log Table (Journal d'idempotence et traçabilité de synchronisation)
CREATE TABLE IF NOT EXISTS "offline_operations_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "device_id" text NOT NULL,
  "client_operation_id" text NOT NULL,
  "operation_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'COMMITTED',
  "client_timestamp" timestamp with time zone NOT NULL,
  "server_timestamp" timestamp with time zone NOT NULL DEFAULT now(),
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "conflict_details" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "offline_ops_client_op_unique" ON "offline_operations_log" ("business_id", "client_operation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offline_ops_business_idx" ON "offline_operations_log" ("business_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offline_ops_device_idx" ON "offline_operations_log" ("device_id");
