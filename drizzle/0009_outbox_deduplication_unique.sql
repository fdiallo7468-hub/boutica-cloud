-- Make the outbox deduplication key enforceable per tenant.
-- Preserve any legacy duplicate rows by assigning a stable legacy suffix
-- before creating the unique index; no notification records are deleted.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY business_id, deduplication_key
      ORDER BY created_at ASC, id ASC
    ) AS duplicate_rank
  FROM notification_outbox
)
UPDATE notification_outbox AS target
SET deduplication_key = target.deduplication_key || ':legacy:' || target.id::text
FROM ranked
WHERE target.id = ranked.id
  AND ranked.duplicate_rank > 1;
--> statement-breakpoint
DROP INDEX IF EXISTS "notification_outbox_dedup_idx";
--> statement-breakpoint
-- Retire the legacy global constraint: deduplication is scoped to each business.
DROP INDEX IF EXISTS "notification_outbox_deduplication_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_outbox_business_dedup_unique"
  ON "notification_outbox" ("business_id", "deduplication_key");
