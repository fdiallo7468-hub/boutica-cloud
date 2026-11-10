import { TenantTransactionService } from "./tenant-transaction.service";
import type { DatabaseService } from "./database";
import type { PoolClient } from "pg";

describe("TenantTransactionService", () => {
  const client = { query: jest.fn(), release: jest.fn() } as unknown as PoolClient;
  const pool = { connect: jest.fn() };
  let service: TenantTransactionService;

  beforeEach(() => {
    jest.clearAllMocks();
    pool.connect.mockResolvedValue(client);
    (client.query as jest.Mock).mockResolvedValue({ rows: [] });
    service = new TenantTransactionService({ pool } as unknown as DatabaseService);
  });

  it("sets tenant variables transaction-locally on the same connection", async () => {
    const result = await service.run({ businessId: "business-1", actorUserId: "user-1", requestId: "request-1" }, async (tx) => {
      expect(tx).toBe(client);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(client.query).toHaveBeenNthCalledWith(2, expect.stringContaining("set_config('app.business_id', $1, true)"), ["business-1", "user-1", "request-1"]);
    expect(client.query).toHaveBeenLastCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases when work fails", async () => {
    const failure = new Error("operation failed");
    await expect(service.run({ businessId: "business-1" }, async () => { throw failure; })).rejects.toBe(failure);
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rejects missing tenant context before acquiring a connection", async () => {
    await expect(service.run({ businessId: " " }, async () => "never")).rejects.toThrow("businessId is required");
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
