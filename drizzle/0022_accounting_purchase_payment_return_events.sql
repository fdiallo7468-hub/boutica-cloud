-- Phase 4.3 increment: purchase, payment and return accounting source events.
ALTER TABLE public.accounting_event_mappings
  DROP CONSTRAINT accounting_event_mappings_source_type_check;
ALTER TABLE public.accounting_event_mappings
  ADD CONSTRAINT accounting_event_mappings_source_type_check
  CHECK (source_type IN ('EXPENSE', 'SALE', 'PURCHASE', 'PAYMENT', 'RETURN'));

ALTER TABLE public.accounting_event_mapping_lines
  DROP CONSTRAINT accounting_event_mapping_lines_basis_check;
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
    'RETURN_DAMAGED_COST'
  ));
