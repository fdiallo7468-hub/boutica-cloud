import { AuditEventsService } from "./audit-events.service";
import type { PoolClient } from "pg";

describe("AuditEventsService", () => {
  const client = { query: jest.fn() } as unknown as PoolClient;
  const service = new AuditEventsService();

  beforeEach(() => jest.clearAllMocks());

  it("appends a parameterized event and returns its id", async () => {
    (client.query as jest.Mock).mockResolvedValue({ rows: [{ id: "event-1" }] });
    const id = await service.append(client, {
      businessId: "business-1",
      actorUserId: "user-1",
      action: "sale.created",
      resourceType: "sale",
      resourceId: "sale-1",
      metadata: { total: 12500 },
    });
    expect(id).toBe("event-1");
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO public.audit_events"),
      ["business-1", "user-1", null, "sale.created", "sale", "sale-1", null, '{"total":12500}'],
    );
  });

  it("rejects invalid metadata before writing", async () => {
    await expect(service.append(client, {
      businessId: "business-1",
      action: "sale.created",
      resourceType: "sale",
      metadata: [] as unknown as Record<string, unknown>,
    })).rejects.toThrow("JSON object");
    expect(client.query).not.toHaveBeenCalled();
  });
});
