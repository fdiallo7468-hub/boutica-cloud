-- Boutica Cloud 3.0 — Phase 2 operational location scope.
-- Additive and backwards-compatible: existing rows are assigned to each
-- business' default location before NOT NULL and tenant-safe FKs are applied.

ALTER TABLE public.business_locations
  ADD CONSTRAINT business_locations_business_id_id_unique UNIQUE (business_id, id);

ALTER TABLE public.variants
  ADD CONSTRAINT variants_business_id_id_unique UNIQUE (business_id, id);

ALTER TABLE public.sales ADD COLUMN location_id uuid;
ALTER TABLE public.purchases ADD COLUMN location_id uuid;
ALTER TABLE public.expenses ADD COLUMN location_id uuid;
ALTER TABLE public.receivables ADD COLUMN location_id uuid;
ALTER TABLE public.payments ADD COLUMN location_id uuid;
ALTER TABLE public.stock_movements ADD COLUMN location_id uuid;

UPDATE public.sales s
SET location_id = l.id
FROM public.business_locations l
WHERE l.business_id = s.business_id AND l.is_default = true;

UPDATE public.purchases p
SET location_id = l.id
FROM public.business_locations l
WHERE l.business_id = p.business_id AND l.is_default = true;

UPDATE public.expenses e
SET location_id = l.id
FROM public.business_locations l
WHERE l.business_id = e.business_id AND l.is_default = true;

UPDATE public.receivables r
SET location_id = l.id
FROM public.business_locations l
WHERE l.business_id = r.business_id AND l.is_default = true;

UPDATE public.payments p
SET location_id = l.id
FROM public.business_locations l
WHERE l.business_id = p.business_id AND l.is_default = true;

UPDATE public.stock_movements m
SET location_id = l.id
FROM public.business_locations l
WHERE l.business_id = m.business_id AND l.is_default = true;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sales WHERE location_id IS NULL)
    OR EXISTS (SELECT 1 FROM public.purchases WHERE location_id IS NULL)
    OR EXISTS (SELECT 1 FROM public.expenses WHERE location_id IS NULL)
    OR EXISTS (SELECT 1 FROM public.receivables WHERE location_id IS NULL)
    OR EXISTS (SELECT 1 FROM public.payments WHERE location_id IS NULL)
    OR EXISTS (SELECT 1 FROM public.stock_movements WHERE location_id IS NULL)
  THEN
    RAISE EXCEPTION 'Cannot backfill operational location_id: one or more businesses have no default location';
  END IF;
END $$;

ALTER TABLE public.sales ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE public.purchases ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE public.expenses ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE public.receivables ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE public.payments ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE public.stock_movements ALTER COLUMN location_id SET NOT NULL;

ALTER TABLE public.sales ADD CONSTRAINT sales_business_location_fk
  FOREIGN KEY (business_id, location_id) REFERENCES public.business_locations (business_id, id) ON DELETE RESTRICT;
ALTER TABLE public.purchases ADD CONSTRAINT purchases_business_location_fk
  FOREIGN KEY (business_id, location_id) REFERENCES public.business_locations (business_id, id) ON DELETE RESTRICT;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_business_location_fk
  FOREIGN KEY (business_id, location_id) REFERENCES public.business_locations (business_id, id) ON DELETE RESTRICT;
ALTER TABLE public.receivables ADD CONSTRAINT receivables_business_location_fk
  FOREIGN KEY (business_id, location_id) REFERENCES public.business_locations (business_id, id) ON DELETE RESTRICT;
ALTER TABLE public.payments ADD CONSTRAINT payments_business_location_fk
  FOREIGN KEY (business_id, location_id) REFERENCES public.business_locations (business_id, id) ON DELETE RESTRICT;
ALTER TABLE public.stock_movements ADD CONSTRAINT stock_movements_business_location_fk
  FOREIGN KEY (business_id, location_id) REFERENCES public.business_locations (business_id, id) ON DELETE RESTRICT;

CREATE INDEX sales_business_location_created_idx ON public.sales (business_id, location_id, created_at DESC);
CREATE INDEX purchases_business_location_created_idx ON public.purchases (business_id, location_id, created_at DESC);
CREATE INDEX expenses_business_location_created_idx ON public.expenses (business_id, location_id, created_at DESC);
CREATE INDEX receivables_business_location_idx ON public.receivables (business_id, location_id);
CREATE INDEX payments_business_location_created_idx ON public.payments (business_id, location_id, created_at DESC);
CREATE INDEX stock_movements_business_location_created_idx ON public.stock_movements (business_id, location_id, created_at DESC);

-- Location-aware stock ledger. Legacy public.stock remains as the compatibility
-- aggregate until all clients and stock workflows are migrated.
CREATE TABLE public.inventory_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  quantity integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_balances_quantity_non_negative CHECK (quantity >= 0),
  CONSTRAINT inventory_balances_scope_unique UNIQUE (business_id, location_id, variant_id),
  CONSTRAINT inventory_balances_business_location_fk
    FOREIGN KEY (business_id, location_id) REFERENCES public.business_locations (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventory_balances_business_variant_fk
    FOREIGN KEY (business_id, variant_id) REFERENCES public.variants (business_id, id) ON DELETE RESTRICT
);
CREATE INDEX inventory_balances_business_variant_idx ON public.inventory_balances (business_id, variant_id);
CREATE INDEX inventory_balances_business_location_idx ON public.inventory_balances (business_id, location_id);

-- Initialize one location balance from the legacy per-business stock snapshot.
INSERT INTO public.inventory_balances (business_id, location_id, variant_id, quantity)
SELECT s.business_id, l.id, s.variant_id, s.quantity
FROM public.stock s
JOIN public.business_locations l
  ON l.business_id = s.business_id AND l.is_default = true
ON CONFLICT (business_id, location_id, variant_id) DO NOTHING;
