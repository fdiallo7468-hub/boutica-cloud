-- Allow tenant-configured, CUMP-valued inventory adjustment postings.
ALTER TABLE public.accounting_event_mappings
  DROP CONSTRAINT accounting_event_mappings_source_type_check;
--> statement-breakpoint
ALTER TABLE public.accounting_event_mappings
  ADD CONSTRAINT accounting_event_mappings_source_type_check
  CHECK (source_type IN ('EXPENSE', 'SALE', 'PURCHASE', 'PAYMENT', 'RETURN', 'STOCK_ADJUSTMENT'));
--> statement-breakpoint
ALTER TABLE public.accounting_event_mapping_lines
  DROP CONSTRAINT accounting_event_mapping_lines_basis_check;
--> statement-breakpoint
ALTER TABLE public.accounting_event_mapping_lines
  ADD CONSTRAINT accounting_event_mapping_lines_basis_check
  CHECK (amount_basis IN (
    'EXPENSE_AMOUNT',
    'SALE_TOTAL',
    'SALE_SUBTOTAL',
    'SALE_DISCOUNT',
    'SALE_COST_AT_SALE',
    'PURCHASE_TOTAL',
    'PAYMENT_AMOUNT',
    'RETURN_TOTAL',
    'RETURN_RESTOCK_COST',
    'RETURN_DAMAGED_COST',
    'STOCK_ADJUSTMENT_VALUE'
  ));
