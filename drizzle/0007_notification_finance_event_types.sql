-- Align the outbox event constraint with the event names emitted by FinanceService.
-- Keep legacy finance.* values so already queued records remain valid.
ALTER TABLE "notification_outbox"
  DROP CONSTRAINT IF EXISTS "notification_outbox_event_type_valid";
--> statement-breakpoint
ALTER TABLE "notification_outbox"
  ADD CONSTRAINT "notification_outbox_event_type_valid"
  CHECK ("event_type" IN (
    'sale.completed',
    'inventory.low_stock',
    'inventory.out_of_stock',
    'finance.receivable_created',
    'finance.payment_received',
    'payment.received',
    'payment.cancelled',
    'receivable.created',
    'receivable.overdue',
    'receivable.settled'
  ));
