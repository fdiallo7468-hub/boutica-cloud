-- Phase 3 loyalty foundation: tenant configuration and append-only points ledger.
CREATE TABLE public.loyalty_configurations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  earn_points_per_1000 integer NOT NULL DEFAULT 1 CHECK (earn_points_per_1000 >= 0),
  point_value numeric(14,4) NOT NULL DEFAULT 1 CHECK (point_value > 0),
  minimum_redemption_points integer NOT NULL DEFAULT 100 CHECK (minimum_redemption_points >= 0),
  expiry_days integer CHECK (expiry_days IS NULL OR expiry_days > 0),
  CONSTRAINT loyalty_configurations_business_unique UNIQUE (business_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.customers ADD CONSTRAINT customers_business_id_id_unique UNIQUE (business_id, id);
--> statement-breakpoint
CREATE TABLE public.loyalty_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  actor_user_id text,
  points_delta integer NOT NULL CHECK (points_delta <> 0),
  event_type text NOT NULL CHECK (event_type IN ('SALE_EARN','RETURN_REVERSAL','MANUAL_ADJUSTMENT')),
  source_id uuid NOT NULL,
  related_sale_id uuid REFERENCES public.sales(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loyalty_ledger_business_idempotency_unique UNIQUE (business_id, idempotency_key),
  CONSTRAINT loyalty_ledger_business_customer_fk FOREIGN KEY (business_id, customer_id) REFERENCES public.customers(business_id, id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX loyalty_ledger_customer_time_idx ON public.loyalty_ledger (business_id, customer_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX loyalty_ledger_sale_idx ON public.loyalty_ledger (business_id, related_sale_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.boutica_reject_loyalty_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'loyalty_ledger is append-only; % is forbidden', TG_OP USING ERRCODE = '55000';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER loyalty_ledger_reject_update_delete
BEFORE UPDATE OR DELETE ON public.loyalty_ledger
FOR EACH ROW EXECUTE FUNCTION public.boutica_reject_loyalty_ledger_mutation();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.loyalty_ledger FROM PUBLIC;
REVOKE ALL ON FUNCTION public.boutica_reject_loyalty_ledger_mutation() FROM PUBLIC;
