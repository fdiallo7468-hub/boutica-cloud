import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "./database";

export interface TenantTransactionContext {
  businessId: string;
  actorUserId?: string | null;
  requestId?: string | null;
}

/** Uses transaction-local PostgreSQL settings; values cannot leak through the pool. */
@Injectable()
export class TenantTransactionService {
  constructor(private readonly database: DatabaseService) {}

  async run<T>(context: TenantTransactionContext, work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!context.businessId?.trim()) throw new Error("A businessId is required for a tenant transaction");

    const client = await this.database.pool.connect();
    let transactionStarted = false;
    let clientDiscarded = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(
        "SELECT set_config('app.business_id', $1, true), set_config('app.actor_user_id', $2, true), set_config('app.request_id', $3, true)",
        [context.businessId, context.actorUserId ?? "", context.requestId ?? ""],
      );
      const result = await work(client);
      await client.query("COMMIT");
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch {
          client.release(true);
          clientDiscarded = true;
        }
      }
      throw error;
    } finally {
      if (!clientDiscarded) client.release();
    }
  }
}
