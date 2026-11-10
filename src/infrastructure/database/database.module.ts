import { Global, Module } from "@nestjs/common";
import { DatabaseService } from "./database";
import { TenantTransactionService } from "./tenant-transaction.service";
import { AuditEventsService } from "./audit-events.service";

@Global()
@Module({
  providers: [DatabaseService, TenantTransactionService, AuditEventsService],
  exports: [DatabaseService, TenantTransactionService, AuditEventsService],
})
export class DatabaseModule {}
