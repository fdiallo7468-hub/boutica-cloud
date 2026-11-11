-- Boutica Cloud 3.0 — Phase 4.1: SYSCOHADA accounting foundations.
-- Additive only. No production migration is performed by this commit.
CREATE TABLE public.accounting_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  country_code char(2) NOT NULL DEFAULT 'ML',
  framework text NOT NULL DEFAULT 'SYSCOHADA_REVISED',
  accounting_system text NOT NULL DEFAULT 'NORMAL',
  currency char(3) NOT NULL DEFAULT 'XOF',
  chart_version text NOT NULL DEFAULT 'SYSCOHADA_2017',
  configured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_profiles_business_unique UNIQUE (business_id),
  CONSTRAINT accounting_profiles_country_check CHECK (country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT accounting_profiles_framework_check CHECK (framework = 'SYSCOHADA_REVISED'),
  CONSTRAINT accounting_profiles_system_check CHECK (accounting_system IN ('NORMAL', 'SMT')),
  CONSTRAINT accounting_profiles_currency_check CHECK (currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE public.accounting_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  account_number varchar(20) NOT NULL,
  label varchar(180) NOT NULL,
  class smallint NOT NULL,
  parent_account_id uuid,
  normal_balance text NOT NULL,
  is_postable boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  source_framework text NOT NULL DEFAULT 'SYSCOHADA_REVISED',
  source_version text NOT NULL DEFAULT 'SYSCOHADA_2017',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_accounts_business_number_unique UNIQUE (business_id, account_number),
  CONSTRAINT accounting_accounts_business_id_id_unique UNIQUE (business_id, id),
  CONSTRAINT accounting_accounts_class_check CHECK (class BETWEEN 1 AND 9),
  CONSTRAINT accounting_accounts_number_check CHECK (account_number ~ '^[0-9]{1,20}$'),
  CONSTRAINT accounting_accounts_label_check CHECK (length(btrim(label)) BETWEEN 2 AND 180),
  CONSTRAINT accounting_accounts_balance_check CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
  CONSTRAINT accounting_accounts_framework_check CHECK (source_framework = 'SYSCOHADA_REVISED'),
  CONSTRAINT accounting_accounts_parent_fk FOREIGN KEY (business_id, parent_account_id)
    REFERENCES public.accounting_accounts (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_accounts_no_self_parent CHECK (parent_account_id IS NULL OR parent_account_id <> id)
);
--> statement-breakpoint
CREATE INDEX accounting_accounts_business_class_idx
  ON public.accounting_accounts (business_id, class, account_number);
--> statement-breakpoint
CREATE INDEX accounting_accounts_business_parent_idx
  ON public.accounting_accounts (business_id, parent_account_id);
--> statement-breakpoint
CREATE TABLE public.accounting_fiscal_years (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  code varchar(30) NOT NULL,
  label varchar(120) NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_fiscal_years_business_code_unique UNIQUE (business_id, code),
  CONSTRAINT accounting_fiscal_years_business_id_id_unique UNIQUE (business_id, id),
  CONSTRAINT accounting_fiscal_years_dates_check CHECK (end_date >= start_date),
  CONSTRAINT accounting_fiscal_years_status_check CHECK (status IN ('OPEN', 'CLOSING', 'CLOSED'))
);
--> statement-breakpoint
CREATE INDEX accounting_fiscal_years_business_dates_idx
  ON public.accounting_fiscal_years (business_id, start_date, end_date);
--> statement-breakpoint
CREATE TABLE public.accounting_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  fiscal_year_id uuid NOT NULL,
  code varchar(30) NOT NULL,
  label varchar(120) NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_periods_business_code_unique UNIQUE (business_id, code),
  CONSTRAINT accounting_periods_business_id_id_unique UNIQUE (business_id, id),
  CONSTRAINT accounting_periods_dates_check CHECK (end_date >= start_date),
  CONSTRAINT accounting_periods_status_check CHECK (status IN ('OPEN', 'CLOSED', 'LOCKED')),
  CONSTRAINT accounting_periods_fiscal_year_fk FOREIGN KEY (business_id, fiscal_year_id)
    REFERENCES public.accounting_fiscal_years (business_id, id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX accounting_periods_business_year_dates_idx
  ON public.accounting_periods (business_id, fiscal_year_id, start_date, end_date);
--> statement-breakpoint
CREATE TABLE public.accounting_journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  location_id uuid,
  code varchar(12) NOT NULL,
  label varchar(120) NOT NULL,
  journal_type text NOT NULL,
  sequence_prefix varchar(20) NOT NULL,
  next_sequence bigint NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_journals_business_code_unique UNIQUE (business_id, code),
  CONSTRAINT accounting_journals_sequence_check CHECK (next_sequence > 0),
  CONSTRAINT accounting_journals_type_check CHECK (
    journal_type IN ('PURCHASE', 'SALES', 'CASH', 'BANK', 'GENERAL', 'OPENING', 'CLOSING', 'PAYROLL')
  ),
  CONSTRAINT accounting_journals_location_fk FOREIGN KEY (business_id, location_id)
    REFERENCES public.business_locations (business_id, id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX accounting_journals_business_type_idx
  ON public.accounting_journals (business_id, journal_type, is_active);
