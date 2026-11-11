-- Complete tenant RLS boundary for Boutica Cloud 3.0.
-- Runtime role must be NOBYPASSRLS. Auth identity tables remain outside tenant RLS.
-- The application sets app.business_id/app.actor_user_id transaction-locally only
-- after Better Auth session resolution and persisted membership verification.

CREATE OR REPLACE FUNCTION public.boutica_current_business_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT NULLIF(current_setting('app.business_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.boutica_current_actor_user_id()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT NULLIF(current_setting('app.actor_user_id', true), '')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.boutica_current_business_id() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.boutica_current_actor_user_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.boutica_current_business_id() TO boutica_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.boutica_current_actor_user_id() TO boutica_runtime;
--> statement-breakpoint

-- Keep the provisioning trigger functions safe when invoked by Better Auth.
ALTER FUNCTION public.boutica_provision_user_business()
  SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.boutica_attach_user_business_membership()
  SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.boutica_create_default_business_location()
  SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.boutica_provision_user_business() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.boutica_attach_user_business_membership() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.boutica_create_default_business_location() FROM PUBLIC;
--> statement-breakpoint

-- Outbox workers are cross-tenant by design, so they use narrowly scoped
-- SECURITY DEFINER operations instead of unrestricted table access.
CREATE OR REPLACE FUNCTION public.boutica_claim_notification_outbox(
  p_batch_size integer,
  p_pending_status text,
  p_processing_status text,
  p_stale_before timestamptz
)
RETURNS SETOF public.notification_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_pending_status NOT IN ('pending', 'PENDING')
     OR p_processing_status NOT IN ('processing', 'PROCESSING')
     OR NOT (
       (p_pending_status = 'pending' AND p_processing_status = 'processing')
       OR (p_pending_status = 'PENDING' AND p_processing_status = 'PROCESSING')
     ) THEN
    RAISE EXCEPTION 'Unsupported notification outbox status pair'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT o.id
    FROM public.notification_outbox AS o
    WHERE
      (o.status = p_pending_status AND o.available_at <= clock_timestamp())
      OR
      (o.status = p_processing_status AND o.locked_at <= p_stale_before)
    ORDER BY o.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_batch_size, 1), 1), 100)
  )
  UPDATE public.notification_outbox AS o
  SET
    status = p_processing_status,
    attempts = o.attempts + 1,
    locked_at = clock_timestamp()
  FROM candidates AS c
  WHERE o.id = c.id
  RETURNING o.*;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.boutica_update_notification_outbox(
  p_id uuid,
  p_business_id uuid,
  p_expected_status text,
  p_status text,
  p_attempts integer,
  p_available_at timestamptz,
  p_locked_at timestamptz,
  p_delivered_at timestamptz,
  p_last_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT (
    (p_expected_status = 'processing' AND p_status IN ('processing', 'pending', 'delivered'))
    OR
    (p_expected_status = 'PROCESSING' AND p_status IN ('PROCESSING', 'PENDING', 'DELIVERED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'Unsupported notification outbox state transition'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.notification_outbox AS o
  SET
    status = p_status,
    attempts = COALESCE(p_attempts, o.attempts),
    available_at = COALESCE(p_available_at, o.available_at),
    locked_at = p_locked_at,
    delivered_at = CASE
      WHEN p_status IN ('delivered', 'DELIVERED') THEN COALESCE(p_delivered_at, clock_timestamp())
      ELSE o.delivered_at
    END,
    last_error = p_last_error
  WHERE o.id = p_id
    AND o.business_id = p_business_id
    AND o.status = p_expected_status;

  RETURN FOUND;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.boutica_claim_notification_outbox(integer, text, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.boutica_update_notification_outbox(uuid, uuid, text, text, integer, timestamptz, timestamptz, timestamptz, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.boutica_claim_notification_outbox(integer, text, text, timestamptz) TO boutica_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.boutica_update_notification_outbox(uuid, uuid, text, text, integer, timestamptz, timestamptz, timestamptz, text) TO boutica_runtime;
--> statement-breakpoint

-- Tenant-keyed tables: RLS is enabled and forced so table-owner sessions are
-- subject to policy too. BYPASSRLS roles (including neondb_owner) still bypass.
DO $$
DECLARE
  table_name text;
  tenant_tables text[] := ARRAY[
    'accounting_accounts',
    'accounting_entries',
    'accounting_entry_lines',
    'accounting_event_mappings',
    'accounting_fiscal_years',
    'accounting_journals',
    'accounting_periods',
    'accounting_profiles',
    'business_activities',
    'business_locations',
    'business_module_configurations',
    'customers',
    'device_serials',
    'expenses',
    'idempotency_keys',
    'inventory_balances',
    'payments',
    'payment_cancellations',
    'products',
    'purchases',
    'push_devices',
    'receivables',
    'returns',
    'stock',
    'stock_movements',
    'suppliers',
    'sync_devices',
    'variants',
    'offline_operations_log'
  ];
BEGIN
  FOREACH table_name IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY boutica_tenant_isolation ON public.%I FOR ALL TO boutica_runtime USING (business_id = public.boutica_current_business_id()) WITH CHECK (business_id = public.boutica_current_business_id())',
      table_name
    );
  END LOOP;
END;
$$;
--> statement-breakpoint

-- Child rows derive tenant ownership exclusively through their parent.
ALTER TABLE public.sale_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.sale_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY boutica_tenant_isolation ON public.sale_items
  FOR ALL TO boutica_runtime
  USING (EXISTS (
    SELECT 1 FROM public.sales AS parent
    WHERE parent.id = sale_items.sale_id
      AND parent.business_id = public.boutica_current_business_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.sales AS parent
    WHERE parent.id = sale_items.sale_id
      AND parent.business_id = public.boutica_current_business_id()
  ));
--> statement-breakpoint
ALTER TABLE public.purchase_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.purchase_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY boutica_tenant_isolation ON public.purchase_items
  FOR ALL TO boutica_runtime
  USING (EXISTS (
    SELECT 1 FROM public.purchases AS parent
    WHERE parent.id = purchase_items.purchase_id
      AND parent.business_id = public.boutica_current_business_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.purchases AS parent
    WHERE parent.id = purchase_items.purchase_id
      AND parent.business_id = public.boutica_current_business_id()
  ));
--> statement-breakpoint
ALTER TABLE public.return_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.return_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY boutica_tenant_isolation ON public.return_items
  FOR ALL TO boutica_runtime
  USING (EXISTS (
    SELECT 1 FROM public.returns AS parent
    WHERE parent.id = return_items.return_id
      AND parent.business_id = public.boutica_current_business_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.returns AS parent
    WHERE parent.id = return_items.return_id
      AND parent.business_id = public.boutica_current_business_id()
  ));
--> statement-breakpoint

-- The tenant root and membership control plane have purpose-specific policies.
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.businesses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY boutica_business_select ON public.businesses
  FOR SELECT TO boutica_runtime
  USING (
    id = public.boutica_current_business_id()
    OR EXISTS (
      SELECT 1
      FROM public.business_members AS membership
      WHERE membership.business_id = businesses.id
        AND membership.user_id = public.boutica_current_actor_user_id()
    )
  );
--> statement-breakpoint
CREATE POLICY boutica_business_insert ON public.businesses
  FOR INSERT TO boutica_runtime
  WITH CHECK (public.boutica_current_actor_user_id() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY boutica_business_update ON public.businesses
  FOR UPDATE TO boutica_runtime
  USING (id = public.boutica_current_business_id())
  WITH CHECK (id = public.boutica_current_business_id());
--> statement-breakpoint
ALTER TABLE public.business_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.business_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY boutica_membership_select ON public.business_members
  FOR SELECT TO boutica_runtime
  USING (
    user_id = public.boutica_current_actor_user_id()
    OR business_id = public.boutica_current_business_id()
  );
--> statement-breakpoint
CREATE POLICY boutica_membership_insert ON public.business_members
  FOR INSERT TO boutica_runtime
  WITH CHECK (
    user_id = public.boutica_current_actor_user_id()
    AND business_id = public.boutica_current_business_id()
  );
--> statement-breakpoint

-- Outbox: tenant-facing access is scoped; cross-tenant worker operations use
-- only the two SECURITY DEFINER functions above.
ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.notification_outbox FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY boutica_outbox_select ON public.notification_outbox
  FOR SELECT TO boutica_runtime
  USING (business_id = public.boutica_current_business_id());
--> statement-breakpoint
CREATE POLICY boutica_outbox_insert ON public.notification_outbox
  FOR INSERT TO boutica_runtime
  WITH CHECK (business_id = public.boutica_current_business_id());
--> statement-breakpoint
CREATE POLICY boutica_outbox_update ON public.notification_outbox
  FOR UPDATE TO boutica_runtime
  USING (business_id = public.boutica_current_business_id())
  WITH CHECK (business_id = public.boutica_current_business_id());
--> statement-breakpoint

-- Audit and loyalty ledgers are append-only: no UPDATE/DELETE policies exist.
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.audit_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY boutica_audit_select ON public.audit_events
  FOR SELECT TO boutica_runtime
  USING (business_id = public.boutica_current_business_id());
--> statement-breakpoint
CREATE POLICY boutica_audit_insert ON public.audit_events
  FOR INSERT TO boutica_runtime
  WITH CHECK (business_id = public.boutica_current_business_id());
--> statement-breakpoint
ALTER TABLE public.loyalty_ledger ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.loyalty_ledger FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY boutica_loyalty_select ON public.loyalty_ledger
  FOR SELECT TO boutica_runtime
  USING (business_id = public.boutica_current_business_id());
--> statement-breakpoint
CREATE POLICY boutica_loyalty_insert ON public.loyalty_ledger
  FOR INSERT TO boutica_runtime
  WITH CHECK (business_id = public.boutica_current_business_id());
--> statement-breakpoint

-- Identity tables users/sessions/accounts/verifications deliberately remain
-- outside tenant RLS: Better Auth must resolve sessions and bootstrap users
-- before a tenant context exists. The membership and business control-plane
-- policies above are the boundary for tenant selection.

-- Remove broad CRUD from tenant data and grant only the required operations.
REVOKE ALL ON TABLE
  public.accounting_accounts,
  public.accounting_entries,
  public.accounting_entry_lines,
  public.accounting_event_mappings,
  public.accounting_fiscal_years,
  public.accounting_journals,
  public.accounting_periods,
  public.accounting_profiles,
  public.audit_events,
  public.business_activities,
  public.business_locations,
  public.business_members,
  public.business_module_configurations,
  public.businesses,
  public.customers,
  public.device_serials,
  public.expenses,
  public.idempotency_keys,
  public.inventory_balances,
  public.loyalty_configurations,
  public.loyalty_ledger,
  public.notification_outbox,
  public.offline_operations_log,
  public.payment_cancellations,
  public.payments,
  public.products,
  public.purchase_items,
  public.purchases,
  public.push_devices,
  public.receivables,
  public.return_items,
  public.returns,
  public.sale_items,
  public.sales,
  public.stock,
  public.stock_movements,
  public.suppliers,
  public.sync_devices,
  public.variants
FROM boutica_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.accounting_accounts,
  public.accounting_entries,
  public.accounting_entry_lines,
  public.accounting_event_mappings,
  public.accounting_fiscal_years,
  public.accounting_journals,
  public.accounting_periods,
  public.accounting_profiles,
  public.business_activities,
  public.business_locations,
  public.business_module_configurations,
  public.customers,
  public.device_serials,
  public.expenses,
  public.idempotency_keys,
  public.inventory_balances,
  public.loyalty_configurations,
  public.offline_operations_log,
  public.payment_cancellations,
  public.payments,
  public.products,
  public.purchase_items,
  public.purchases,
  public.push_devices,
  public.receivables,
  public.return_items,
  public.returns,
  public.sale_items,
  public.sales,
  public.stock,
  public.stock_movements,
  public.suppliers,
  public.sync_devices,
  public.variants
TO boutica_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.audit_events, public.loyalty_ledger TO boutica_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE public.notification_outbox TO boutica_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.business_members TO boutica_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE public.businesses TO boutica_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  REVOKE ALL ON TABLES FROM boutica_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM boutica_runtime;
