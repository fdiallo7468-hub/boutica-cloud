import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";

export interface CreateAuditEvent {
  businessId: string;
  actorUserId?: string | null;
  locationId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

/** INSERT-only audit writer. Mutations are additionally rejected by a database trigger. */
@Injectable()
export class AuditEventsService {
  /** Appends through a Drizzle transaction so the audit row commits or rolls back with the business mutation. */
  async appendInTransaction(
    transaction: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
    event: CreateAuditEvent,
  ): Promise<string> {
    const action = event.action.trim();
    const resourceType = event.resourceType.trim();
    if (action.length < 2 || action.length > 120) throw new Error("Invalid audit action length");
    if (resourceType.length < 2 || resourceType.length > 80) throw new Error("Invalid audit resource type length");

    const metadata = event.metadata ?? {};
    if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
      throw new Error("Audit metadata must be a JSON object");
    }

    const result = await transaction.execute(sql`
      INSERT INTO public.audit_events
        (business_id, actor_user_id, location_id, action, resource_type, resource_id, request_id, metadata)
      VALUES
        (${event.businessId}, ${event.actorUserId ?? null}, ${event.locationId ?? null}, ${action},
         ${resourceType}, ${event.resourceId ?? null}, ${event.requestId ?? null}, ${JSON.stringify(metadata)}::jsonb)
      RETURNING id
    `);
    const rows = (result as { rows?: Array<{ id: string }> }).rows ?? [];
    const insertedEvent = rows[0];
    if (!insertedEvent) throw new Error("Audit event insert did not return an id");
    return insertedEvent.id;
  }

  async append(client: PoolClient, event: CreateAuditEvent): Promise<string> {
    const action = event.action.trim();
    const resourceType = event.resourceType.trim();
    if (action.length < 2 || action.length > 120) throw new Error("Invalid audit action length");
    if (resourceType.length < 2 || resourceType.length > 80) throw new Error("Invalid audit resource type length");

    const metadata = event.metadata ?? {};
    if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
      throw new Error("Audit metadata must be a JSON object");
    }

    const result = await client.query<{ id: string }>(
      "INSERT INTO public.audit_events (business_id, actor_user_id, location_id, action, resource_type, resource_id, request_id, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id",
      [event.businessId, event.actorUserId ?? null, event.locationId ?? null, action, resourceType,
       event.resourceId ?? null, event.requestId ?? null, JSON.stringify(metadata)],
    );

    const insertedEvent = result.rows[0];
    if (!insertedEvent) {
      throw new Error("Audit event insert did not return an id");
    }

    return insertedEvent.id;
  }
}
