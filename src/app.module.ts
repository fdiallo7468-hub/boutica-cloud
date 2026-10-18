import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "@thallesp/nestjs-better-auth";
import { envSchema } from "./config/env.schema";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { DomainExceptionFilter } from "./common/errors/domain-exception.filter";
import { auth } from "./auth/auth";

// Infrastructure Modules (Phases 2, 3, 5, 6)
import { SecurityModule } from "./infrastructure/security/security.module";
import { ArcjetGuard } from "./infrastructure/security/arcjet.guard";
import { StorageModule } from "./infrastructure/storage/storage.module";
import { JobsModule } from "./infrastructure/jobs/jobs.module";
import { NotificationsModule } from "./infrastructure/notifications/notifications.module";

// Business Domain Modules
import { CatalogModule } from "./modules/catalog/catalog.module";
import { InventoryModule } from "./modules/inventory/inventory.module";
import { SalesModule } from "./modules/sales/sales.module";
import { PurchasingModule } from "./modules/purchasing/purchasing.module";
import { ReturnsModule } from "./modules/returns/returns.module";
import { SuppliersModule } from "./modules/suppliers/suppliers.module";
import { ExpensesModule } from "./modules/expenses/expenses.module";
import { CustomersModule } from "./modules/customers/customers.module";
import { ReportsModule } from "./modules/reports/reports.module";
import { HealthModule } from "./modules/health/health.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envSchema }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    DatabaseModule,
    AuthModule.forRoot(auth),
    SecurityModule,
    StorageModule,
    JobsModule,
    NotificationsModule,
    CatalogModule,
    InventoryModule,
    SalesModule,
    PurchasingModule,
    ReturnsModule,
    SuppliersModule,
    ExpensesModule,
    CustomersModule,
    ReportsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ArcjetGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {}
