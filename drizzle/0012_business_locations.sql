-- Boutica Cloud v3 — business locations and default-location provisioning.
-- Additive only: existing business and transaction data remain untouched.
CREATE TABLE IF NOT EXISTS public.business_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  address text,
  phone text,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_locations_code_format_check
    CHECK (code ~ '^[A-Z0-9_-]{2,20}$'),
  CONSTRAINT business_locations_name_length_check
    CHECK (length(btrim(name)) BETWEEN 2 AND 120)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS business_locations_business_code_unique
  ON public.business_locations (business_id, code);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS business_locations_one_default_per_business_unique
  ON public.business_locations (business_id)
  WHERE is_default = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS business_locations_business_idx
  ON public.business_locations (business_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS business_locations_active_idx
  ON public.business_locations (business_id, is_active);
--> statement-breakpoint
-- Backfill exactly one deterministic primary location for every existing tenant.
INSERT INTO public.business_locations (
  business_id, code, name, address, phone, is_default, is_active
)
SELECT b.id, 'MAIN', 'Établissement principal', b.address, b.phone, true, true
FROM public.businesses AS b
WHERE NOT EXISTS (
  SELECT 1
  FROM public.business_locations AS l
  WHERE l.business_id = b.id
    AND l.is_default = true
);
--> statement-breakpoint
-- Every future business created through any application path receives a primary location.
CREATE OR REPLACE FUNCTION public.boutica_create_default_business_location()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.business_locations (
    business_id, code, name, address, phone, is_default, is_active
  )
  VALUES (
    NEW.id, 'MAIN', 'Établissement principal', NEW.address, NEW.phone, true, true
  )
  ON CONFLICT (business_id, code) DO NOTHING;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS businesses_create_default_location_after_insert ON public.businesses;
--> statement-breakpoint
CREATE TRIGGER businesses_create_default_location_after_insert
AFTER INSERT ON public.businesses
FOR EACH ROW
EXECUTE FUNCTION public.boutica_create_default_business_location();
