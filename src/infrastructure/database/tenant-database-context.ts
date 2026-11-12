import { Injectable } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-local Drizzle transaction. AsyncLocalStorage keeps the checked-out
 * PostgreSQL transaction isolated between concurrent HTTP requests.
 */
@Injectable()
export class TenantDatabaseContext {
  private readonly storage = new AsyncLocalStorage<unknown>();

  get current(): unknown {
    return this.storage.getStore();
  }

  run<T>(transaction: unknown, callback: () => T): T {
    return this.storage.run(transaction, callback);
  }
}
