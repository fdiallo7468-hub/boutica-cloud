import { TenantDatabaseContext } from "./tenant-database-context";
import { TenantTransactionService } from "./tenant-transaction.service";
import type { DatabaseService } from "./database";

describe("TenantTransactionService", () => {
  const transaction = { execute: jest.fn().mockResolvedValue({ rows: [] }) };
  const baseDb = {
    transaction: jest.fn(async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)),
  };
  const context = new TenantDatabaseContext();
  let service: TenantTransactionService;

  beforeEach(() => {
    jest.clearAllMocks();
    baseDb.transaction.mockImplementation(async (work) => work(transaction));
    transaction.execute.mockResolvedValue({ rows: [] });
    service = new TenantTransactionService(
      { baseDb } as unknown as DatabaseService,
      context,
    );
  });

  it("sets tenant variables and exposes the same Drizzle transaction through AsyncLocalStorage", async () => {
    const result = await service.run(
      { businessId: "business-1", actorUserId: "user-1", requestId: "request-1" },
      async () => {
        expect(context.current).toBe(transaction);
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(baseDb.transaction).toHaveBeenCalledTimes(1);
    expect(transaction.execute).toHaveBeenCalledTimes(1);
    expect(context.current).toBeUndefined();
  });

  it("rolls back the Drizzle transaction when work fails and restores context", async () => {
    const failure = new Error("operation failed");
    await expect(service.run({ businessId: "business-1" }, async () => {
      expect(context.current).toBe(transaction);
      throw failure;
    })).rejects.toBe(failure);
    expect(context.current).toBeUndefined();
  });

  it("rejects missing tenant context before opening a transaction", async () => {
    await expect(service.run({ businessId: " " }, async () => "never"))
      .rejects.toThrow("businessId is required");
    expect(baseDb.transaction).not.toHaveBeenCalled();
  });
});
