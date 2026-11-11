-- Boutica Cloud 3.0 — Phase 4.2/4.4: journal entries and ledger.
-- Additive migration. Production is not migrated by this change.
CREATE TABLE public.accounting_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  journal_id uuid NOT NULL,
  period_id uuid NOT NULL,
  entry_number varchar(60) NOT NULL,
  entry_date date NOT NULL,
  description varchar(240) NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  source_type text,
  source_id text,
  idempotency_key varchar(120),
  request_hash text,
  reversal_of_entry_id uuid,
  posted_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_entries_business_id_id_unique UNIQUE (business_id, id),
  CONSTRAINT accounting_entries_business_number_unique UNIQUE (business_id, entry_number),
  CONSTRAINT accounting_entries_journal_fk FOREIGN KEY (business_id, journal_id)
    REFERENCES public.accounting_journals (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_entries_period_fk FOREIGN KEY (business_id, period_id)
    REFERENCES public.accounting_periods (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_entries_reversal_fk FOREIGN KEY (business_id, reversal_of_entry_id)
    REFERENCES public.accounting_entries (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_entries_status_check CHECK (status IN ('DRAFT', 'POSTED')),
  CONSTRAINT accounting_entries_source_pair_check CHECK ((source_type IS NULL) = (source_id IS NULL)),
  CONSTRAINT accounting_entries_description_check CHECK (length(btrim(description)) BETWEEN 2 AND 240),
  CONSTRAINT accounting_entries_no_self_reversal CHECK (reversal_of_entry_id IS NULL OR reversal_of_entry_id <> id)
);
CREATE UNIQUE INDEX accounting_entries_source_unique
  ON public.accounting_entries (business_id, source_type, source_id)
  WHERE source_type IS NOT NULL;
CREATE UNIQUE INDEX accounting_entries_idempotency_unique
  ON public.accounting_entries (business_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX accounting_entries_single_reversal_unique
  ON public.accounting_entries (business_id, reversal_of_entry_id)
  WHERE reversal_of_entry_id IS NOT NULL;
CREATE INDEX accounting_entries_business_date_idx
  ON public.accounting_entries (business_id, entry_date, id);
CREATE INDEX accounting_entries_business_period_idx
  ON public.accounting_entries (business_id, period_id, entry_date);

CREATE TABLE public.accounting_entry_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  line_number integer NOT NULL,
  account_id uuid NOT NULL,
  description varchar(240),
  debit numeric(18,2) NOT NULL DEFAULT 0,
  credit numeric(18,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_entry_lines_entry_fk FOREIGN KEY (business_id, entry_id)
    REFERENCES public.accounting_entries (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_entry_lines_account_fk FOREIGN KEY (business_id, account_id)
    REFERENCES public.accounting_accounts (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_entry_lines_entry_line_unique UNIQUE (entry_id, line_number),
  CONSTRAINT accounting_entry_lines_line_number_check CHECK (line_number > 0),
  CONSTRAINT accounting_entry_lines_amounts_check CHECK (
    debit >= 0 AND credit >= 0 AND
    ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
  )
);
CREATE INDEX accounting_entry_lines_business_account_idx
  ON public.accounting_entry_lines (business_id, account_id, entry_id);

-- Posted accounting data is append-only. Corrections are new reversal entries.
CREATE FUNCTION public.reject_posted_accounting_entry_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target_business_id uuid;
DECLARE target_entry_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_business_id := OLD.business_id;
    target_entry_id := OLD.id;
    IF TG_TABLE_NAME = 'accounting_entry_lines' THEN
      target_entry_id := OLD.entry_id;
    END IF;
  ELSE
    target_business_id := NEW.business_id;
    target_entry_id := NEW.id;
    IF TG_TABLE_NAME = 'accounting_entry_lines' THEN
      target_entry_id := NEW.entry_id;
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.accounting_entries e
    WHERE e.business_id = target_business_id AND e.id = target_entry_id AND e.status = 'POSTED'
  ) THEN
    RAISE EXCEPTION 'Posted accounting entries are immutable; create a reversal entry';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accounting_entries_append_only
  BEFORE UPDATE OR DELETE ON public.accounting_entries
  FOR EACH ROW EXECUTE FUNCTION public.reject_posted_accounting_entry_mutation();
CREATE TRIGGER accounting_entry_lines_append_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_entry_lines
  FOR EACH ROW EXECUTE FUNCTION public.reject_posted_accounting_entry_mutation();
