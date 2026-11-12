import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DatabaseService } from "./database";
import { TenantDatabaseContext } from "./tenant-database-context";

export interface TenantTransactionContext {
  businessId: string;
  actorUserId?: string | null;
  requestId?: string | null;
}

/** Runs every query in the callback on one transaction with transaction-local tenant identity. */
@Injectable()
export class TenantTransactionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly tenantDatabaseContext: TenantDatabaseContext,
  ) {}

  async run<T>(context: TenantTransactionContext, work: () => Promise<T>): Promise<T> {
    if (!context.businessId?.trim()) {
      throw new Error("A businessId is required for a tenant transaction");
    }

    return this.database.baseDb.transaction(async (transaction) => {
      await transaction.execute(sql`
        SELECT
          set_config('app.business_id', ${context.businessId}, true),
          set_config('app.actor_user_id', ${context.actorUserId ?? ""}, true),
          set_config('app.request_id', ${context.requestId ?? ""}, true)
      `);
      return this.tenantDatabaseContext.run(transaction, work);
    });
  }
}
