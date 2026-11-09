-- Provision the initial business and all of its defaults in the same PostgreSQL
-- transaction as the Better Auth user row. If any insert fails, the user row
-- and every related business row are rolled back together.
CREATE OR REPLACE FUNCTION boutica_provision_user_business()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  created_business_id uuid;
  normalized_sector text;
BEGIN
  -- Backward-compatible rollout: the previous application version provisioned
  -- the business in its Better Auth hook and supplied business_id here. Preserve
  -- that already-created tenant during the migration-first deployment window.
  IF NEW.business_id IS NOT NULL THEN
    NEW.email := lower(btrim(NEW.email));
    RETURN NEW;
  END IF;

  IF NEW.business_name IS NULL OR length(btrim(NEW.business_name)) < 2 OR length(btrim(NEW.business_name)) > 120 THEN
    RAISE EXCEPTION 'A valid business name is required to create a Boutica account'
      USING ERRCODE = '23514';
  END IF;

  normalized_sector := CASE upper(btrim(coalesce(NEW.business_sector, 'QUINCAILLERIE')))
    WHEN 'ELECTRONIQUE' THEN 'ELECTRONIQUE'
    ELSE 'QUINCAILLERIE'
  END;

  INSERT INTO businesses (name, currency, phone, sector, address)
  VALUES (
    btrim(NEW.business_name),
    CASE
      WHEN upper(btrim(coalesce(NEW.business_currency, ''))) ~ '^[A-Z]{3}$'
        THEN upper(btrim(NEW.business_currency))
      ELSE 'XOF'
    END,
    nullif(btrim(coalesce(NEW.business_phone, '')), ''),
    normalized_sector,
    nullif(btrim(coalesce(NEW.business_address, '')), '')
  )
  RETURNING id INTO created_business_id;

  NEW.business_id := created_business_id;
  NEW.role := 'OWNER';
  NEW.email := lower(btrim(NEW.email));
  NEW.personal_phone := nullif(btrim(coalesce(NEW.personal_phone, '')), '');

  IF normalized_sector = 'ELECTRONIQUE' THEN
    INSERT INTO business_activities (business_id, activity, is_active)
    VALUES
      (created_business_id, 'PHONES_ACCESSORIES', true),
      (created_business_id, 'COMPUTERS_IT', true),
      (created_business_id, 'TV_AUDIOVISUAL', true),
      (created_business_id, 'HOME_APPLIANCES', true),
      (created_business_id, 'ELECTRONIC_EQUIPMENT', true),
      (created_business_id, 'ELECTRONIC_COMPONENTS', true)
    ON CONFLICT (business_id, activity) DO NOTHING;

    INSERT INTO business_module_configurations (business_id, module, is_enabled, settings)
    VALUES
      (created_business_id, 'IMEI_TRACKING', true, '{}'::jsonb),
      (created_business_id, 'SERIAL_NUMBERS', true, '{}'::jsonb),
      (created_business_id, 'WARRANTIES', true, '{}'::jsonb),
      (created_business_id, 'DEVICE_MANAGEMENT', true, '{}'::jsonb),
      (created_business_id, 'PRODUCT_VARIANTS', true, '{}'::jsonb),
      (created_business_id, 'POS_FAST_CHECKOUT', true, '{}'::jsonb),
      (created_business_id, 'DISCOUNT_MANAGEMENT', true, '{}'::jsonb),
      (created_business_id, 'THERMAL_RECEIPTS', true, '{}'::jsonb),
      (created_business_id, 'STOCK_AUDIT', true, '{}'::jsonb)
    ON CONFLICT (business_id, module) DO NOTHING;
  ELSE
    INSERT INTO business_activities (business_id, activity, is_active)
    VALUES
      (created_business_id, 'CONSTRUCTION_MATERIALS', true),
      (created_business_id, 'TOOLS_EQUIPMENT', true),
      (created_business_id, 'PLUMBING', true),
      (created_business_id, 'ELECTRICITY', true),
      (created_business_id, 'PAINT', true),
      (created_business_id, 'GENERAL_HARDWARE', true)
    ON CONFLICT (business_id, activity) DO NOTHING;

    INSERT INTO business_module_configurations (business_id, module, is_enabled, settings)
    VALUES
      (created_business_id, 'UNITS_OF_MEASURE', true, '{}'::jsonb),
      (created_business_id, 'UNIT_CONVERSIONS', true, '{}'::jsonb),
      (created_business_id, 'PRODUCT_VARIANTS', true, '{}'::jsonb),
      (created_business_id, 'MULTI_UNIT_SALES', true, '{}'::jsonb),
      (created_business_id, 'POS_FAST_CHECKOUT', true, '{}'::jsonb),
      (created_business_id, 'DISCOUNT_MANAGEMENT', true, '{}'::jsonb),
      (created_business_id, 'THERMAL_RECEIPTS', true, '{}'::jsonb),
      (created_business_id, 'STOCK_AUDIT', true, '{}'::jsonb)
    ON CONFLICT (business_id, module) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION boutica_attach_user_business_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.business_id IS NULL THEN
    RAISE EXCEPTION 'Boutica user must be provisioned with a business'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO business_members (business_id, user_id, role)
  VALUES (NEW.business_id, NEW.id, 'OWNER')
  ON CONFLICT (business_id, user_id) DO NOTHING;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS users_provision_business_before_insert ON users;
--> statement-breakpoint
CREATE TRIGGER users_provision_business_before_insert
BEFORE INSERT ON users
FOR EACH ROW
EXECUTE FUNCTION boutica_provision_user_business();
--> statement-breakpoint
DROP TRIGGER IF EXISTS users_attach_business_membership_after_insert ON users;
--> statement-breakpoint
CREATE TRIGGER users_attach_business_membership_after_insert
AFTER INSERT ON users
FOR EACH ROW
EXECUTE FUNCTION boutica_attach_user_business_membership();
