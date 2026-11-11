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
RETURNS TABLE (id uuid, business_id uuid)
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
  RETURNING o.id, o.business_id;
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
  IF p_business_id IS DISTINCT FROM public.boutica_current_business_id() THEN
    RAISE EXCEPTION 'Notification outbox tenant context mismatch'
      USING ERRCODE = '42501';
  END IF;

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

--> statement-breakpoint
-- Complete the direct-key coverage: these two tables were missing from the
-- original tenant table array and must not remain outside RLS.
ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.sales FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY boutica_tenant_isolation ON public.sales
  FOR ALL TO boutica_runtime
  USING (business_id=public.boutica_current_business_id())
  WITH CHECK (business_id=public.boutica_current_business_id());
--> statement-breakpoint
ALTER TABLE public.loyalty_configurations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.loyalty_configurations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY boutica_tenant_isolation ON public.loyalty_configurations
  FOR ALL TO boutica_runtime
  USING (business_id=public.boutica_current_business_id())
  WITH CHECK (business_id=public.boutica_current_business_id());
--> statement-breakpoint

-- New business rows are assigned an application-generated UUID before INSERT.
-- This lets INSERT ... RETURNING satisfy the SELECT policy without a bootstrap
-- visibility gap. The trigger-based Better Auth provisioning path is SECURITY DEFINER.
DROP POLICY boutica_business_insert ON public.businesses;
--> statement-breakpoint
CREATE POLICY boutica_business_insert ON public.businesses
  FOR INSERT TO boutica_runtime
  WITH CHECK (
    id=public.boutica_current_business_id()
    AND public.boutica_current_actor_user_id() IS NOT NULL
  );
--> statement-breakpoint
DROP POLICY boutica_membership_insert ON public.business_members;
--> statement-breakpoint
CREATE POLICY boutica_membership_insert ON public.business_members
  FOR INSERT TO boutica_runtime
  WITH CHECK (
    user_id=public.boutica_current_actor_user_id()
    AND business_id=public.boutica_current_business_id()
    AND role='OWNER'
  );
--> statement-breakpoint

-- Child references must be tenant-consistent as well as parent-consistent.
CREATE POLICY sale_items_variant_same_tenant ON public.sale_items AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (EXISTS (
    SELECT 1 FROM public.variants v
    WHERE v.id=sale_items.variant_id
      AND v.business_id=public.boutica_current_business_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.variants v
    WHERE v.id=sale_items.variant_id
      AND v.business_id=public.boutica_current_business_id()
  ));
--> statement-breakpoint
CREATE POLICY purchase_items_variant_same_tenant ON public.purchase_items AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (EXISTS (
    SELECT 1 FROM public.variants v
    WHERE v.id=purchase_items.variant_id
      AND v.business_id=public.boutica_current_business_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.variants v
    WHERE v.id=purchase_items.variant_id
      AND v.business_id=public.boutica_current_business_id()
  ));
--> statement-breakpoint
CREATE POLICY return_items_consistent_links ON public.return_items AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (EXISTS (
    SELECT 1 FROM public.returns r
    JOIN public.sale_items si ON si.id=return_items.sale_item_id
    JOIN public.sales s ON s.id=si.sale_id
    JOIN public.variants v ON v.id=return_items.variant_id
    WHERE r.id=return_items.return_id
      AND r.business_id=public.boutica_current_business_id()
      AND r.sale_id=si.sale_id
      AND si.variant_id=return_items.variant_id
      AND s.business_id=r.business_id
      AND v.business_id=r.business_id
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.returns r
    JOIN public.sale_items si ON si.id=return_items.sale_item_id
    JOIN public.sales s ON s.id=si.sale_id
    JOIN public.variants v ON v.id=return_items.variant_id
    WHERE r.id=return_items.return_id
      AND r.business_id=public.boutica_current_business_id()
      AND r.sale_id=si.sale_id
      AND si.variant_id=return_items.variant_id
      AND s.business_id=r.business_id
      AND v.business_id=r.business_id
  ));
--> statement-breakpoint

-- Reject cross-tenant references even where a legacy FK checks only a UUID.
CREATE POLICY sales_customer_same_tenant ON public.sales AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (customer_id IS NULL OR EXISTS (
    SELECT 1 FROM public.customers c WHERE c.id=sales.customer_id AND c.business_id=sales.business_id
  ))
  WITH CHECK (customer_id IS NULL OR EXISTS (
    SELECT 1 FROM public.customers c WHERE c.id=sales.customer_id AND c.business_id=sales.business_id
  ));
--> statement-breakpoint
CREATE POLICY purchases_supplier_same_tenant ON public.purchases AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (supplier_id IS NULL OR EXISTS (
    SELECT 1 FROM public.suppliers s WHERE s.id=purchases.supplier_id AND s.business_id=purchases.business_id
  ))
  WITH CHECK (supplier_id IS NULL OR EXISTS (
    SELECT 1 FROM public.suppliers s WHERE s.id=purchases.supplier_id AND s.business_id=purchases.business_id
  ));
--> statement-breakpoint
CREATE POLICY returns_sale_same_tenant ON public.returns AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (EXISTS (
    SELECT 1 FROM public.sales s WHERE s.id=returns.sale_id AND s.business_id=returns.business_id
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.sales s WHERE s.id=returns.sale_id AND s.business_id=returns.business_id
  ));
--> statement-breakpoint
CREATE POLICY payments_refs_same_tenant ON public.payments AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (
    (customer_id IS NULL OR EXISTS (SELECT 1 FROM public.customers c WHERE c.id=payments.customer_id AND c.business_id=payments.business_id))
    AND (sale_id IS NULL OR EXISTS (SELECT 1 FROM public.sales s WHERE s.id=payments.sale_id AND s.business_id=payments.business_id))
    AND (receivable_id IS NULL OR EXISTS (SELECT 1 FROM public.receivables r WHERE r.id=payments.receivable_id AND r.business_id=payments.business_id))
  )
  WITH CHECK (
    (customer_id IS NULL OR EXISTS (SELECT 1 FROM public.customers c WHERE c.id=payments.customer_id AND c.business_id=payments.business_id))
    AND (sale_id IS NULL OR EXISTS (SELECT 1 FROM public.sales s WHERE s.id=payments.sale_id AND s.business_id=payments.business_id))
    AND (receivable_id IS NULL OR EXISTS (SELECT 1 FROM public.receivables r WHERE r.id=payments.receivable_id AND r.business_id=payments.business_id))
  );
--> statement-breakpoint
CREATE POLICY receivables_refs_same_tenant ON public.receivables AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (
    EXISTS (SELECT 1 FROM public.customers c WHERE c.id=receivables.customer_id AND c.business_id=receivables.business_id)
    AND (sale_id IS NULL OR EXISTS (SELECT 1 FROM public.sales s WHERE s.id=receivables.sale_id AND s.business_id=receivables.business_id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.customers c WHERE c.id=receivables.customer_id AND c.business_id=receivables.business_id)
    AND (sale_id IS NULL OR EXISTS (SELECT 1 FROM public.sales s WHERE s.id=receivables.sale_id AND s.business_id=receivables.business_id))
  );
--> statement-breakpoint
CREATE POLICY stock_variant_same_tenant ON public.stock AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (EXISTS (SELECT 1 FROM public.variants v WHERE v.id=stock.variant_id AND v.business_id=stock.business_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.variants v WHERE v.id=stock.variant_id AND v.business_id=stock.business_id));
--> statement-breakpoint
CREATE POLICY stock_movement_variant_same_tenant ON public.stock_movements AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (EXISTS (SELECT 1 FROM public.variants v WHERE v.id=stock_movements.variant_id AND v.business_id=stock_movements.business_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.variants v WHERE v.id=stock_movements.variant_id AND v.business_id=stock_movements.business_id));
--> statement-breakpoint
CREATE POLICY device_serial_variant_same_tenant ON public.device_serials AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (EXISTS (SELECT 1 FROM public.variants v WHERE v.id=device_serials.variant_id AND v.business_id=device_serials.business_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.variants v WHERE v.id=device_serials.variant_id AND v.business_id=device_serials.business_id));
--> statement-breakpoint
CREATE POLICY payment_cancel_payment_same_tenant ON public.payment_cancellations AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (EXISTS (SELECT 1 FROM public.payments p WHERE p.id=payment_cancellations.payment_id AND p.business_id=payment_cancellations.business_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.payments p WHERE p.id=payment_cancellations.payment_id AND p.business_id=payment_cancellations.business_id));
--> statement-breakpoint
CREATE POLICY loyalty_sale_same_tenant ON public.loyalty_ledger AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (related_sale_id IS NULL OR EXISTS (
    SELECT 1 FROM public.sales s WHERE s.id=loyalty_ledger.related_sale_id AND s.business_id=loyalty_ledger.business_id
  ))
  WITH CHECK (related_sale_id IS NULL OR EXISTS (
    SELECT 1 FROM public.sales s WHERE s.id=loyalty_ledger.related_sale_id AND s.business_id=loyalty_ledger.business_id
  ));
--> statement-breakpoint
CREATE POLICY audit_location_same_tenant ON public.audit_events AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (location_id IS NULL OR EXISTS (
    SELECT 1 FROM public.business_locations l WHERE l.id=audit_events.location_id AND l.business_id=audit_events.business_id
  ))
  WITH CHECK (location_id IS NULL OR EXISTS (
    SELECT 1 FROM public.business_locations l WHERE l.id=audit_events.location_id AND l.business_id=audit_events.business_id
  ));
--> statement-breakpoint
CREATE POLICY push_device_member_same_tenant ON public.push_devices AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (EXISTS (
    SELECT 1 FROM public.business_members bm WHERE bm.business_id=push_devices.business_id AND bm.user_id=push_devices.user_id
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.business_members bm WHERE bm.business_id=push_devices.business_id AND bm.user_id=push_devices.user_id
  ));
--> statement-breakpoint
CREATE POLICY sync_device_member_same_tenant ON public.sync_devices AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (EXISTS (
    SELECT 1 FROM public.business_members bm WHERE bm.business_id=sync_devices.business_id AND bm.user_id=sync_devices.user_id
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.business_members bm WHERE bm.business_id=sync_devices.business_id AND bm.user_id=sync_devices.user_id
  ));
--> statement-breakpoint

-- Preserve the append-only audit contract: the runtime can append and read
-- only the generated identifier needed by INSERT ... RETURNING.
REVOKE SELECT ON TABLE public.audit_events FROM boutica_runtime;
GRANT SELECT (id) ON TABLE public.audit_events TO boutica_runtime;
--> statement-breakpoint
-- Keep future tables/sequences closed by default; each migration must grant
-- the exact operations it needs.
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  REVOKE ALL ON TABLES FROM boutica_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM boutica_runtime;

--> statement-breakpoint
-- Remaining legacy references that are not represented by composite FKs.
CREATE POLICY variants_product_same_tenant ON public.variants AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (EXISTS (
    SELECT 1 FROM public.products p
    WHERE p.id=variants.product_id AND p.business_id=variants.business_id
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.products p
    WHERE p.id=variants.product_id AND p.business_id=variants.business_id
  ));
--> statement-breakpoint
CREATE POLICY device_serial_sale_item_same_tenant ON public.device_serials AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (sale_item_id IS NULL OR EXISTS (
    SELECT 1 FROM public.sale_items si
    JOIN public.sales s ON s.id=si.sale_id
    WHERE si.id=device_serials.sale_item_id
      AND s.business_id=device_serials.business_id
  ))
  WITH CHECK (sale_item_id IS NULL OR EXISTS (
    SELECT 1 FROM public.sale_items si
    JOIN public.sales s ON s.id=si.sale_id
    WHERE si.id=device_serials.sale_item_id
      AND s.business_id=device_serials.business_id
  ));
--> statement-breakpoint
CREATE POLICY payments_recorder_same_tenant ON public.payments AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (EXISTS (
    SELECT 1 FROM public.business_members bm
    WHERE bm.business_id=payments.business_id AND bm.user_id=payments.recorded_by
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.business_members bm
    WHERE bm.business_id=payments.business_id AND bm.user_id=payments.recorded_by
  ));
--> statement-breakpoint
CREATE POLICY payment_cancellations_actor_same_tenant ON public.payment_cancellations AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (EXISTS (
    SELECT 1 FROM public.business_members bm
    WHERE bm.business_id=payment_cancellations.business_id AND bm.user_id=payment_cancellations.cancelled_by
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.business_members bm
    WHERE bm.business_id=payment_cancellations.business_id AND bm.user_id=payment_cancellations.cancelled_by
  ));
--> statement-breakpoint
CREATE POLICY audit_actor_same_tenant ON public.audit_events AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (actor_user_id IS NULL OR EXISTS (
    SELECT 1 FROM public.business_members bm
    WHERE bm.business_id=audit_events.business_id AND bm.user_id=audit_events.actor_user_id
  ))
  WITH CHECK (actor_user_id IS NULL OR EXISTS (
    SELECT 1 FROM public.business_members bm
    WHERE bm.business_id=audit_events.business_id AND bm.user_id=audit_events.actor_user_id
  ));
--> statement-breakpoint
CREATE POLICY loyalty_actor_same_tenant ON public.loyalty_ledger AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (actor_user_id IS NULL OR EXISTS (
    SELECT 1 FROM public.business_members bm
    WHERE bm.business_id=loyalty_ledger.business_id AND bm.user_id=loyalty_ledger.actor_user_id
  ))
  WITH CHECK (actor_user_id IS NULL OR EXISTS (
    SELECT 1 FROM public.business_members bm
    WHERE bm.business_id=loyalty_ledger.business_id AND bm.user_id=loyalty_ledger.actor_user_id
  ));
--> statement-breakpoint
CREATE POLICY offline_operation_device_same_tenant ON public.offline_operations_log AS RESTRICTIVE
  FOR ALL TO boutica_runtime
  USING (EXISTS (
    SELECT 1 FROM public.sync_devices d
    WHERE d.business_id=offline_operations_log.business_id
      AND d.device_id=offline_operations_log.device_id
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.sync_devices d
    WHERE d.business_id=offline_operations_log.business_id
      AND d.device_id=offline_operations_log.device_id
  ));
