-- Explicit account mappings for operational events; never infer accounts.
CREATE TABLE public.accounting_event_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  source_type text NOT NULL,
  source_category varchar(80) NOT NULL,
  journal_id uuid NOT NULL,
  debit_account_id uuid NOT NULL,
  credit_account_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_event_mappings_business_id_id_unique UNIQUE (business_id, id),
  CONSTRAINT accounting_event_mappings_business_category_unique UNIQUE (business_id, source_type, source_category),
  CONSTRAINT accounting_event_mappings_journal_fk FOREIGN KEY (business_id, journal_id)
    REFERENCES public.accounting_journals (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_event_mappings_debit_account_fk FOREIGN KEY (business_id, debit_account_id)
    REFERENCES public.accounting_accounts (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_event_mappings_credit_account_fk FOREIGN KEY (business_id, credit_account_id)
    REFERENCES public.accounting_accounts (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_event_mappings_distinct_accounts_check CHECK (debit_account_id <> credit_account_id),
  CONSTRAINT accounting_event_mappings_source_type_check CHECK (source_type IN ('EXPENSE')),
  CONSTRAINT accounting_event_mappings_category_check CHECK (length(btrim(source_category)) BETWEEN 1 AND 80)
);
CREATE INDEX accounting_event_mappings_business_active_idx
  ON public.accounting_event_mappings (business_id, source_type, is_active);
