import { Injectable } from "@nestjs/common";
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
    return result.rows[0].id;
  }
}
