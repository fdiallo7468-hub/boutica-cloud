-- Moving weighted-average inventory valuation (CUMP), scoped per business and variant.
-- Existing non-zero stock is intentionally NOT backfilled: variants.purchase_price
-- is a mutable catalog value, not a reliable historical opening valuation.
CREATE TABLE IF NOT EXISTS public.inventory_valuations (
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES public.variants(id) ON DELETE CASCADE,
  quantity integer NOT NULL DEFAULT 0,
  average_unit_cost numeric(14,2) NOT NULL DEFAULT '0',
  total_value numeric(18,2) NOT NULL DEFAULT '0',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_valuations_pkey PRIMARY KEY (business_id, variant_id),
  CONSTRAINT inventory_valuations_quantity_non_negative CHECK (quantity >= 0),
  CONSTRAINT inventory_valuations_average_non_negative CHECK (average_unit_cost >= 0),
  CONSTRAINT inventory_valuations_total_non_negative CHECK (total_value >= 0)
);
CREATE INDEX IF NOT EXISTS inventory_valuations_business_idx
  ON public.inventory_valuations (business_id);
