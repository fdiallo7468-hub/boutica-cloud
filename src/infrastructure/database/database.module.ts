import { Global, Module } from "@nestjs/common";
import { DatabaseService } from "./database";
import { TenantTransactionService } from "./tenant-transaction.service";
import { AuditEventsService } from "./audit-events.service";
import { TenantDatabaseContext } from "./tenant-database-context";
import { TenantDatabaseInterceptor } from "./tenant-database.interceptor";

@Global()
@Module({
  providers: [DatabaseService, TenantTransactionService, AuditEventsService, TenantDatabaseContext, TenantDatabaseInterceptor],
  exports: [DatabaseService, TenantTransactionService, AuditEventsService, TenantDatabaseContext, TenantDatabaseInterceptor],
})
export class DatabaseModule {}
