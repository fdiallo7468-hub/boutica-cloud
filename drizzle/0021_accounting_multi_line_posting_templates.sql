-- Phase 4.3 increment: tenant-owned multi-line operational posting templates.
-- Preserve existing expense mappings by migrating their debit/credit pair into lines.

ALTER TABLE public.accounting_entries
  ADD COLUMN location_id uuid;

ALTER TABLE public.accounting_entries
  ADD CONSTRAINT accounting_entries_location_fk
  FOREIGN KEY (business_id, location_id)
  REFERENCES public.business_locations (business_id, id)
  ON DELETE RESTRICT;

CREATE INDEX accounting_entries_business_location_date_idx
  ON public.accounting_entries (business_id, location_id, entry_date);

ALTER TABLE public.accounting_event_mappings
  ALTER COLUMN debit_account_id DROP NOT NULL,
  ALTER COLUMN credit_account_id DROP NOT NULL;

ALTER TABLE public.accounting_event_mappings
  DROP CONSTRAINT accounting_event_mappings_source_type_check;

ALTER TABLE public.accounting_event_mappings
  ADD CONSTRAINT accounting_event_mappings_source_type_check
  CHECK (source_type IN ('EXPENSE', 'SALE'));

CREATE TABLE public.accounting_event_mapping_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  mapping_id uuid NOT NULL,
  line_number integer NOT NULL,
  account_id uuid NOT NULL,
  side text NOT NULL,
  amount_basis text NOT NULL,
  percentage numeric(7,4) NOT NULL DEFAULT 100.0000,
  auxiliary_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_event_mapping_lines_mapping_fk
    FOREIGN KEY (business_id, mapping_id)
    REFERENCES public.accounting_event_mappings (business_id, id)
    ON DELETE CASCADE,
  CONSTRAINT accounting_event_mapping_lines_account_fk
    FOREIGN KEY (business_id, account_id)
    REFERENCES public.accounting_accounts (business_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT accounting_event_mapping_lines_unique
    UNIQUE (business_id, mapping_id, line_number),
  CONSTRAINT accounting_event_mapping_lines_number_check
    CHECK (line_number > 0),
  CONSTRAINT accounting_event_mapping_lines_side_check
    CHECK (side IN ('DEBIT', 'CREDIT')),
  CONSTRAINT accounting_event_mapping_lines_basis_check
    CHECK (amount_basis IN (
      'EXPENSE_AMOUNT',
      'SALE_TOTAL',
      'SALE_SUBTOTAL',
      'SALE_DISCOUNT',
      'SALE_COST_AT_SALE'
    )),
  CONSTRAINT accounting_event_mapping_lines_percentage_check
    CHECK (percentage > 0 AND percentage <= 100),
  CONSTRAINT accounting_event_mapping_lines_auxiliary_check
    CHECK (auxiliary_type IS NULL OR auxiliary_type IN ('CUSTOMER', 'SUPPLIER'))
);

CREATE INDEX accounting_event_mapping_lines_business_mapping_idx
  ON public.accounting_event_mapping_lines (business_id, mapping_id, line_number);

-- Backfill existing single-pair expense configuration as a two-line template.
INSERT INTO public.accounting_event_mapping_lines
  (business_id, mapping_id, line_number, account_id, side, amount_basis, percentage)
SELECT business_id, id, 1, debit_account_id, 'DEBIT', 'EXPENSE_AMOUNT', 100.0000
FROM public.accounting_event_mappings
WHERE source_type = 'EXPENSE'
UNION ALL
SELECT business_id, id, 2, credit_account_id, 'CREDIT', 'EXPENSE_AMOUNT', 100.0000
FROM public.accounting_event_mappings
WHERE source_type = 'EXPENSE';
