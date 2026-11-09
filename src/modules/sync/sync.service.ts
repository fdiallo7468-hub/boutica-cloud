import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { and, eq, gt, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import {
  customers,
  expenses,
  offlineOperationsLog,
  payments,
  products,
  receivables,
  saleItems,
  sales,
  stock,
  stockMovements,
  suppliers,
  syncDevices,
  variants,
} from '../../infrastructure/database/schema';
import { Tenant } from '../auth/tenant.type';
import { FinanceService } from '../finance/finance.service';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';
import { NOVU_EVENT_TYPES } from '../notifications/novu.types';
import { OfflineOperationItemDto, RegisterDeviceDto, SyncPushDto } from './dto/sync.dto';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly financeService: FinanceService,
    private readonly outboxService: NotificationOutboxService,
  ) {}

  /**
   * Enregistre ou met à jour un appareil Desktop ou Mobile dans le Cloud.
   */
  async registerDevice(tenant: Tenant, dto: RegisterDeviceDto) {
    const [existing] = await this.db.db
      .select()
      .from(syncDevices)
      .where(
        and(
          eq(syncDevices.businessId, tenant.businessId),
          eq(syncDevices.deviceId, dto.deviceId),
        ),
      );

    if (existing) {
      const [updated] = await this.db.db
        .update(syncDevices)
        .set({
          deviceType: dto.deviceType,
          deviceName: dto.deviceName || existing.deviceName,
          appVersion: dto.appVersion || existing.appVersion,
          updatedAt: new Date(),
        })
        .where(eq(syncDevices.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await this.db.db
      .insert(syncDevices)
      .values({
        businessId: tenant.businessId,
        userId: tenant.userId,
        deviceId: dto.deviceId,
        deviceType: dto.deviceType,
        deviceName: dto.deviceName || null,
        appVersion: dto.appVersion || null,
      })
      .returning();

    return created;
  }

  /**
   * Retourne l'état de synchronisation de l'appareil et de la connexion.
   */
  async getSyncStatus(tenant: Tenant, deviceId?: string) {
    const serverTimestamp = new Date().toISOString();

    let device: typeof syncDevices.$inferSelect | null = null;
    if (deviceId) {
      const [found] = await this.db.db
        .select()
        .from(syncDevices)
        .where(
          and(
            eq(syncDevices.businessId, tenant.businessId),
            eq(syncDevices.deviceId, deviceId),
          ),
        );
      device = found || null;
    }

    return {
      status: 'ONLINE',
      serverTimestamp,
      businessId: tenant.businessId,
      device: device
        ? {
            deviceId: device.deviceId,
            deviceType: device.deviceType,
            deviceName: device.deviceName,
            lastSyncAt: device.lastSyncAt,
          }
        : null,
    };
  }

  /**
   * Delta Synchronization (Pull) :
   * Retourne toutes les données créées ou modifiées depuis 'since' pour l'entreprise active.
   */
  async pullDeltas(tenant: Tenant, sinceIso?: string) {
    const serverTimestamp = new Date();
    const sinceDate = sinceIso ? new Date(sinceIso) : null;
    if (sinceIso && (!sinceDate || Number.isNaN(sinceDate.getTime()))) {
      throw new BadRequestException('The sync cursor must be a valid ISO date');
    }

    const filterByDate = (colCreated: any, colUpdated?: any) => {
      const bizFilter = eq(colCreated.table.businessId, tenant.businessId);
      if (!sinceDate) return bizFilter;
      if (colUpdated) {
        return and(bizFilter, or(gt(colCreated, sinceDate), gt(colUpdated, sinceDate)));
      }
      return and(bizFilter, gt(colCreated, sinceDate));
    };

    const [
      customersList,
      suppliersList,
      productsList,
      variantsList,
      salesList,
      receivablesList,
      paymentsList,
      expensesList,
      stockList,
    ] = await Promise.all([
      this.db.db.select().from(customers).where(filterByDate(customers.createdAt, customers.updatedAt)),
      this.db.db.select().from(suppliers).where(filterByDate(suppliers.createdAt, suppliers.updatedAt)),
      this.db.db.select().from(products).where(filterByDate(products.createdAt, products.updatedAt)),
      this.db.db
        .select({
          id: variants.id,
          productId: variants.productId,
          sku: variants.sku,
          name: variants.name,
          purchasePrice: variants.purchasePrice,
          sellingPrice: variants.sellingPrice,
          unit: variants.unit,
          hasSerial: variants.hasSerial,
          hasImei: variants.hasImei,
          warrantyMonths: variants.warrantyMonths,
          imageUrl: variants.imageUrl,
          createdAt: variants.createdAt,
          updatedAt: variants.updatedAt,
        })
        .from(variants)
        .innerJoin(products, eq(variants.productId, products.id))
        .where(
          sinceDate
            ? and(
                eq(variants.businessId, tenant.businessId),
                or(gt(variants.createdAt, sinceDate), gt(variants.updatedAt, sinceDate)),
              )
            : eq(variants.businessId, tenant.businessId),
        ),
      this.db.db.select().from(sales).where(filterByDate(sales.createdAt)),
      this.db.db.select().from(receivables).where(filterByDate(receivables.createdAt, receivables.updatedAt)),
      this.db.db.select().from(payments).where(filterByDate(payments.createdAt, payments.updatedAt)),
      this.db.db.select().from(expenses).where(filterByDate(expenses.createdAt)),
      this.db.db
        .select()
        .from(stock)
        .where(
          sinceDate
            ? and(eq(stock.businessId, tenant.businessId), gt(stock.updatedAt, sinceDate))
            : eq(stock.businessId, tenant.businessId),
        ),
    ]);

    // Récupérer les sale_items associés aux ventes récupérées
    let saleItemsList: any[] = [];
    if (salesList.length > 0) {
      saleItemsList = await this.db.db
        .select()
        .from(saleItems)
        .where(
          sql`${saleItems.saleId} IN (${sql.join(
            salesList.map((s) => sql`${s.id}::uuid`),
            sql`, `,
          )})`,
        );
    }

    return {
      serverTimestamp: serverTimestamp.toISOString(),
      deltas: {
        customers: customersList,
        suppliers: suppliersList,
        products: productsList,
        variants: variantsList,
        sales: salesList,
        saleItems: saleItemsList,
        receivables: receivablesList,
        payments: paymentsList,
        expenses: expensesList,
        stock: stockList,
      },
    };
  }

  /**
   * Batch Ingestion (Push) :
   * Traite et valide les opérations générées hors ligne dans une transaction sécurisée.
   * Trie les opérations selon les dépendances et garantit l'idempotence stricte par clientOperationId.
   */
  async pushOfflineOperations(tenant: Tenant, dto: SyncPushDto) {
    const serverTimestamp = new Date();
    const results: Array<{ clientOperationId: string; status: 'COMMITTED' | 'REJECTED'; entityId?: string; error?: string }> = [];

    // Priorité des opérations pour respecter l'ordre d'intégrité relationnelle
    const getPriority = (type: string): number => {
      switch (type) {
        case 'CREATE_CUSTOMER':
        case 'CREATE_SUPPLIER':
          return 1;
        case 'CREATE_SALE':
        case 'CREATE_PURCHASE':
          return 2;
        case 'RECORD_PAYMENT':
        case 'CREATE_RECEIVABLE':
          return 3;
        case 'RECORD_EXPENSE':
          return 4;
        default:
          return 5;
      }
    };

    const sortedOps = [...dto.operations].sort(
      (a, b) => getPriority(a.operationType) - getPriority(b.operationType),
    );

    await this.db.db.transaction(async (tx) => {
      for (const op of sortedOps) {
        try {
          // 1. Vérification d'idempotence stricte
          const [existingOp] = await tx
            .select()
            .from(offlineOperationsLog)
            .where(
              and(
                eq(offlineOperationsLog.businessId, tenant.businessId),
                eq(offlineOperationsLog.clientOperationId, op.clientOperationId),
              ),
            );

          if (existingOp) {
            results.push({
              clientOperationId: op.clientOperationId,
              status: existingOp.status as 'COMMITTED' | 'REJECTED',
              entityId: (existingOp.payload as any)?.entityId,
            });
            continue;
          }

          let entityId: string | undefined;

          // 2. Exécution selon le type d'opération
          switch (op.operationType) {
            case 'CREATE_CUSTOMER': {
              const p = op.payload as any;
              const [c] = await tx
                .insert(customers)
                .values({
                  id: p.id || undefined,
                  businessId: tenant.businessId,
                  name: p.name,
                  phone: p.phone || null,
                })
                .onConflictDoNothing()
                .returning();
              if (!c) {
                throw new ConflictException('Customer identifier already exists or could not be created');
              }
              entityId = c.id;
              break;
            }

            case 'CREATE_SALE': {
              const p = op.payload as any;
              const saleId = p.id || undefined;

              if (!Array.isArray(p.items) || p.items.length === 0) {
                throw new BadRequestException('A synchronized sale must contain at least one item');
              }
              for (const amount of [p.subtotal, p.discount ?? 0, p.total]) {
                if (!Number.isFinite(Number(amount)) || Number(amount) < 0) {
                  throw new BadRequestException('Sale amounts must be finite non-negative numbers');
                }
              }
              if (p.customerId) {
                const [customer] = await tx
                  .select({ id: customers.id })
                  .from(customers)
                  .where(and(
                    eq(customers.id, p.customerId),
                    eq(customers.businessId, tenant.businessId),
                    eq(customers.isActive, true),
                  ))
                  .limit(1);
                if (!customer) {
                  throw new BadRequestException('Customer does not belong to this business or is inactive');
                }
              }
              for (const item of p.items) {
                if (!item || typeof item.variantId !== 'string' || !Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
                  throw new BadRequestException('Each sale item requires a valid variant and a positive integer quantity');
                }
                if (!Number.isFinite(Number(item.unitPrice)) || Number(item.unitPrice) < 0) {
                  throw new BadRequestException('Sale item unit prices must be finite non-negative numbers');
                }
                const [ownedVariant] = await tx
                  .select({ id: variants.id })
                  .from(variants)
                  .innerJoin(products, eq(variants.productId, products.id))
                  .where(and(
                    eq(variants.id, item.variantId),
                    eq(products.businessId, tenant.businessId),
                  ))
                  .limit(1);
                if (!ownedVariant) {
                  throw new BadRequestException('A sale item references a variant outside this business');
                }
              }

              const [sale] = await tx
                .insert(sales)
                .values({
                  id: saleId,
                  businessId: tenant.businessId,
                  customerId: p.customerId || null,
                  status: 'COMPLETED',
                  subtotal: p.subtotal.toString(),
                  discount: (p.discount || 0).toString(),
                  total: p.total.toString(),
                  createdAt: op.clientTimestamp ? new Date(op.clientTimestamp) : new Date(),
                })
                .onConflictDoNothing()
                .returning();

              if (!sale) {
                throw new ConflictException('Sale identifier already exists or could not be created');
              }
              entityId = sale.id;

              // Insertion des lignes de vente et décrémentation atomique de stock
              if (p.items && Array.isArray(p.items)) {
                for (const item of p.items) {
                  await tx.insert(saleItems).values({
                    saleId: entityId!,
                    variantId: item.variantId,
                    quantity: item.quantity,
                    unitPrice: item.unitPrice.toString(),
                    costAtSale: item.costAtSale ? item.costAtSale.toString() : null,
                  });

                  // Décrémentation de stock (delta)
                  await tx
                    .insert(stock)
                    .values({
                      businessId: tenant.businessId,
                      variantId: item.variantId,
                      quantity: -item.quantity,
                    })
                    .onConflictDoUpdate({
                      // variantId is the primary key of the stock table.
                      target: stock.variantId,
                      set: {
                        quantity: sql`${stock.quantity} - ${item.quantity}`,
                        updatedAt: new Date(),
                      },
                    });

                  // Mouvement de stock d'audit
                  await tx.insert(stockMovements).values({
                    businessId: tenant.businessId,
                    variantId: item.variantId,
                    type: 'SALE',
                    quantity: -item.quantity,
                    note: `Vente synchronisée ${entityId}`,
                  });
                }
              }

              // Émission d'événement outbox Novu
              await this.outboxService.enqueue(tx, {
                businessId: tenant.businessId,
                eventType: NOVU_EVENT_TYPES.SALE_COMPLETED,
                deduplicationKey: `sale-completed-${entityId}`,
                payload: {
                  saleId: entityId,
                  total: p.total,
                  itemsCount: p.items?.length || 0,
                  recipientId: tenant.userId,
                },
              });
              break;
            }

            case 'RECORD_PAYMENT': {
              const p = op.payload as any;
              const payment = await this.financeService.recordPayment(tenant, {
                customerId: p.customerId,
                receivableId: p.receivableId,
                saleId: p.saleId,
                amount: Number(p.amount),
                paymentMethod: p.paymentMethod,
                transactionReference: p.transactionReference,
                notes: p.notes,
              });
              entityId = payment.id;
              break;
            }

            case 'RECORD_EXPENSE': {
              const p = op.payload as any;
              const [exp] = await tx
                .insert(expenses)
                .values({
                  id: p.id || undefined,
                  businessId: tenant.businessId,
                  category: p.category,
                  description: p.description || null,
                  amount: p.amount.toString(),
                  createdAt: op.clientTimestamp ? new Date(op.clientTimestamp) : new Date(),
                })
                .returning();
              entityId = exp?.id || p.id;
              break;
            }

            default:
              throw new BadRequestException(`Unsupported offline operation type: ${op.operationType}`);
          }

          // 3. Journaliser le succès de l'opération
          await tx.insert(offlineOperationsLog).values({
            businessId: tenant.businessId,
            deviceId: dto.deviceId,
            clientOperationId: op.clientOperationId,
            operationType: op.operationType,
            status: 'COMMITTED',
            clientTimestamp: new Date(op.clientTimestamp),
            serverTimestamp,
            payload: { ...op.payload, entityId },
          });

          results.push({
            clientOperationId: op.clientOperationId,
            status: 'COMMITTED',
            entityId,
          });
        } catch (err: any) {
          this.logger.error(`Erreur lors du traitement de l'opération ${op.clientOperationId} : ${err.message}`);
          results.push({
            clientOperationId: op.clientOperationId,
            status: 'REJECTED',
            error: err.message || 'Erreur interne de validation',
          });
        }
      }

      // 4. Mettre à jour l'horodatage de l'appareil
      await tx
        .update(syncDevices)
        .set({
          lastSyncAt: serverTimestamp,
          updatedAt: serverTimestamp,
        })
        .where(
          and(
            eq(syncDevices.businessId, tenant.businessId),
            eq(syncDevices.deviceId, dto.deviceId),
          ),
        );
    });

    return {
      serverTimestamp: serverTimestamp.toISOString(),
      results,
    };
  }
}
