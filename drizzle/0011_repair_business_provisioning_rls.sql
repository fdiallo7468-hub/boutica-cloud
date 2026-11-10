-- Repair the partial RLS configuration on businesses.
--
-- The API's tenant boundary is currently enforced by the authenticated
-- CurrentTenant context and explicit business_id / business_members filters.
-- No request-scoped PostgreSQL tenant identity is propagated yet, so a
-- tenant-aware RLS policy cannot be evaluated safely on pooled connections.
-- The previous one-table RLS flag had no policies: it blocked legitimate
-- provisioning and business-profile reads/writes without protecting the
-- other tenant tables. Disable this incomplete policy layer until a complete
-- request-scoped RLS implementation is introduced for every tenant table.
ALTER TABLE public.businesses DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Trigger functions are owned by neondb_owner (the businesses table owner).
-- SECURITY DEFINER lets atomic provisioning execute with that owner so the
-- BEFORE INSERT trigger is not blocked by table-level RLS settings.
ALTER FUNCTION public.boutica_provision_user_business()
  SECURITY DEFINER;
--> statement-breakpoint
ALTER FUNCTION public.boutica_provision_user_business()
  SET search_path = pg_catalog, public;
--> statement-breakpoint
ALTER FUNCTION public.boutica_attach_user_business_membership()
  SECURITY DEFINER;
--> statement-breakpoint
ALTER FUNCTION public.boutica_attach_user_business_membership()
  SET search_path = pg_catalog, public;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.boutica_provision_user_business() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.boutica_attach_user_business_membership() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.boutica_provision_user_business() TO boutica_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.boutica_attach_user_business_membership() TO boutica_runtime;
