import { TenantDatabaseContext } from "./tenant-database-context";

describe("TenantDatabaseContext", () => {
  it("isolates concurrent asynchronous request contexts", async () => {
    const context = new TenantDatabaseContext();
    const first = { id: "transaction-1" };
    const second = { id: "transaction-2" };

    const [firstResult, secondResult] = await Promise.all([
      context.run(first, async () => {
        await Promise.resolve();
        return context.current;
      }),
      context.run(second, async () => {
        await Promise.resolve();
        return context.current;
      }),
    ]);

    expect(firstResult).toBe(first);
    expect(secondResult).toBe(second);
    expect(context.current).toBeUndefined();
  });
});
