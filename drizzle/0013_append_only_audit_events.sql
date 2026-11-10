-- Boutica Cloud v3 — append-only audit events.
-- The application writes through an INSERT-only API; the database trigger
-- independently rejects UPDATE and DELETE, including accidental ORM writes.
CREATE TABLE IF NOT EXISTS public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  actor_user_id text REFERENCES public.users(id) ON DELETE SET NULL,
  location_id uuid,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_action_length_check CHECK (length(btrim(action)) BETWEEN 2 AND 120),
  CONSTRAINT audit_events_resource_type_length_check CHECK (length(btrim(resource_type)) BETWEEN 2 AND 80),
  CONSTRAINT audit_events_metadata_object_check CHECK (jsonb_typeof(metadata) = 'object')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_events_business_time_idx
  ON public.audit_events (business_id, occurred_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_events_business_resource_idx
  ON public.audit_events (business_id, resource_type, resource_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_events_actor_time_idx
  ON public.audit_events (actor_user_id, occurred_at DESC);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.boutica_reject_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only; % is forbidden', TG_OP
    USING ERRCODE = '55000';
END;
$function$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_events_reject_update_delete ON public.audit_events;
--> statement-breakpoint
CREATE TRIGGER audit_events_reject_update_delete
BEFORE UPDATE OR DELETE ON public.audit_events
FOR EACH ROW EXECUTE FUNCTION public.boutica_reject_audit_event_mutation();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_events FROM PUBLIC;
REVOKE ALL ON FUNCTION public.boutica_reject_audit_event_mutation() FROM PUBLIC;
