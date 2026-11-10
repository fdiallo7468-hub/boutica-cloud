import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, lte } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import {
  businesses,
  businessLocations,
  customers,
  paymentCancellations,
  payments,
  receivables,
  sales,
} from '../../infrastructure/database/schema';
import { Tenant } from '../auth/tenant.type';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';
import { NOVU_EVENT_TYPES } from '../notifications/novu.types';
import {
  CancelPaymentDto,
  CreatePaymentDto,
  CreateReceivableFromSaleDto,
} from './dto/finance.dto';

@Injectable()
export class FinanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly outboxService: NotificationOutboxService,
  ) {}

  /**
   * Enregistre un paiement indépendant ou lié à une créance / vente.
   * Exécuté dans une transaction stricte avec génération de reçu unique
   * et émission d'un événement Outbox.
   */
  async recordPayment(tenant: Tenant, dto: CreatePaymentDto, transaction?: any) {
    if (!Number.isFinite(dto.amount) || dto.amount <= 0) {
      throw new BadRequestException('Le montant du paiement doit être strictement positif');
    }

    // 1. Vérification du client dans le périmètre de l'entreprise
    const executor = transaction ?? this.db.db;
    const [customer] = await executor
      .select()
      .from(customers)
      .where(and(eq(customers.id, dto.customerId), eq(customers.businessId, tenant.businessId)));

    if (!customer) {
      throw new NotFoundException('Client introuvable pour cette entreprise');
    }

    const receiptNumber = `REC-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

    const execute = async (tx: any) => {
      let targetReceivable: typeof receivables.$inferSelect | null = null;
      let saleLocationId: string | null = null;

      // A supplied saleId must belong to this tenant and to the same customer.
      if (dto.saleId) {
        const [sale] = await tx
          .select()
          .from(sales)
          .where(and(
            eq(sales.id, dto.saleId),
            eq(sales.businessId, tenant.businessId),
          ))
          .for('update');

        if (!sale) {
          throw new NotFoundException('Vente introuvable pour cette entreprise');
        }
        saleLocationId = sale.locationId;
        if (sale.status !== 'COMPLETED' || sale.customerId !== dto.customerId) {
          throw new BadRequestException('Le paiement doit correspondre au client d’une vente terminée');
        }
      }

      // 2. Si le paiement est associé à une créance, vérifier le solde
      if (dto.receivableId) {
        const [rec] = await tx
          .select()
          .from(receivables)
          .where(
            and(
              eq(receivables.id, dto.receivableId),
              eq(receivables.businessId, tenant.businessId),
            ),
          )
          // Serialize payments against the same receivable. The balance check
          // must observe the latest committed balance, not a stale snapshot.
          .for('update');

        if (!rec) {
          throw new NotFoundException('Créance introuvable');
        }

        if (rec.customerId !== dto.customerId) {
          throw new BadRequestException('Le client du paiement ne correspond pas au client de la créance');
        }
        if (dto.saleId && dto.saleId !== rec.saleId) {
          throw new BadRequestException('La vente du paiement ne correspond pas à la vente de la créance');
        }
        if (rec.status === 'PAID' || rec.status === 'CANCELLED') {
          throw new BadRequestException(`Cette créance est déjà clôturée (statut: ${rec.status})`);
        }

        const remaining = Number(rec.remainingBalance);
        if (dto.amount > remaining) {
          throw new BadRequestException(
            `Le montant du paiement (${dto.amount} FCFA) dépasse le solde restant de la créance (${remaining} FCFA)`,
          );
        }

        targetReceivable = rec;
        saleLocationId = rec.locationId;
      }

      const [defaultLocation] = await tx.select({ id: businessLocations.id }).from(businessLocations).where(and(
        eq(businessLocations.businessId, tenant.businessId),
        eq(businessLocations.isDefault, true),
        eq(businessLocations.isActive, true),
      ));
      const paymentLocationId = saleLocationId ?? defaultLocation?.id;
      if (!paymentLocationId) throw new BadRequestException('No active default business location is configured');

      // 3. Insérer le paiement
      const [payment] = await tx
        .insert(payments)
        .values({
          businessId: tenant.businessId,
          locationId: paymentLocationId,
          customerId: dto.customerId,
          saleId: dto.saleId || targetReceivable?.saleId || null,
          receivableId: dto.receivableId || null,
          amount: dto.amount.toString(),
          paymentMethod: dto.paymentMethod,
          transactionReference: dto.transactionReference || null,
          recordedBy: tenant.userId,
          status: 'CONFIRMED',
          receiptNumber,
          notes: dto.notes || null,
        })
        .returning();

      if (!payment) {
        throw new InternalServerErrorException('Échec de la génération de la transaction de paiement');
      }

      // 4. Mettre à jour la créance associée
      let isSettled = false;
      if (targetReceivable) {
        const newPaid = Number(targetReceivable.paidAmount) + dto.amount;
        const newRemaining = Math.max(0, Number(targetReceivable.remainingBalance) - dto.amount);
        isSettled = newRemaining === 0;

        await tx
          .update(receivables)
          .set({
            paidAmount: newPaid.toFixed(2),
            remainingBalance: newRemaining.toFixed(2),
            status: isSettled ? 'PAID' : 'PARTIALLY_PAID',
            updatedAt: new Date(),
          })
          .where(and(
            eq(receivables.id, targetReceivable.id),
            eq(receivables.businessId, tenant.businessId),
          ));
      }

      // 5. Enregistrer les événements d'outbox dans la transaction
      await this.outboxService.enqueue(tx, {
        businessId: tenant.businessId,
        eventType: NOVU_EVENT_TYPES.PAYMENT_RECEIVED,
        deduplicationKey: `payment-received-${payment.id}`,
        payload: {
          paymentId: payment.id,
          receiptNumber: payment.receiptNumber,
          amount: dto.amount,
          paymentMethod: dto.paymentMethod,
          customerName: customer.name,
          recipientId: tenant.userId,
        },
      });

      if (isSettled && targetReceivable) {
        await this.outboxService.enqueue(tx, {
          businessId: tenant.businessId,
          eventType: NOVU_EVENT_TYPES.RECEIVABLE_SETTLED,
          deduplicationKey: `receivable-settled-${targetReceivable.id}`,
          payload: {
            receivableId: targetReceivable.id,
            saleId: targetReceivable.saleId,
            customerName: customer.name,
            totalSettled: Number(targetReceivable.initialAmount),
            recipientId: tenant.userId,
          },
        });
      }

      return {
        ...payment,
        customerName: customer.name,
        receivableSettled: isSettled,
      };
    };
    return transaction ? execute(transaction) : this.db.db.transaction(execute);
  }

  /**
   * Annule un paiement avec traçabilité et mise à jour de la créance.
   */
  async cancelPayment(tenant: Tenant, paymentId: string, dto: CancelPaymentDto) {
    return this.db.db.transaction(async (tx) => {
      const [payment] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.id, paymentId),
            eq(payments.businessId, tenant.businessId),
          ),
        )
        // Prevent two concurrent cancellation requests from restoring the
        // same receivable balance twice.
        .for('update');

      if (!payment) {
        throw new NotFoundException('Paiement introuvable');
      }

      if (payment.status !== 'CONFIRMED') {
        throw new ConflictException('Seul un paiement confirmé peut être annulé');
      }

      // 1. Marquer le paiement comme annulé
      const [updatedPayment] = await tx
        .update(payments)
        .set({
          status: 'CANCELLED',
          updatedAt: new Date(),
        })
        .where(and(
          eq(payments.id, paymentId),
          eq(payments.businessId, tenant.businessId),
          eq(payments.status, 'CONFIRMED'),
        ))
        .returning();

      if (!updatedPayment) {
        throw new ConflictException('Le paiement a déjà été modifié par une autre opération');
      }

      // 2. Restaurer la créance si le paiement y était rattaché
      if (payment.receivableId) {
        const [rec] = await tx
          .select()
          .from(receivables)
          .where(and(
            eq(receivables.id, payment.receivableId),
            eq(receivables.businessId, tenant.businessId),
          ))
          .for('update');

        if (rec) {
          const restoredPaid = Math.max(0, Number(rec.paidAmount) - Number(payment.amount));
          const restoredRemaining = Math.min(
            Number(rec.initialAmount),
            Number(rec.remainingBalance) + Number(payment.amount),
          );
          const newStatus = restoredPaid === 0 ? 'PENDING' : 'PARTIALLY_PAID';

          await tx
            .update(receivables)
            .set({
              paidAmount: restoredPaid.toFixed(2),
              remainingBalance: restoredRemaining.toFixed(2),
              status: newStatus,
              updatedAt: new Date(),
            })
            .where(and(
              eq(receivables.id, rec.id),
              eq(receivables.businessId, tenant.businessId),
            ));
        }
      }

      // 3. Journaliser l'annulation
      await tx.insert(paymentCancellations).values({
        businessId: tenant.businessId,
        paymentId,
        cancelledBy: tenant.userId,
        reason: dto.reason.trim(),
      });

      // 4. Émettre l'événement outbox
      await this.outboxService.enqueue(tx, {
        businessId: tenant.businessId,
        eventType: NOVU_EVENT_TYPES.PAYMENT_CANCELLED,
        deduplicationKey: `payment-cancelled-${paymentId}`,
        payload: {
          paymentId,
          receiptNumber: payment.receiptNumber,
          amount: Number(payment.amount),
          reason: dto.reason,
          recipientId: tenant.userId,
        },
      });

      return {
        success: true,
        message: 'Paiement annulé et créance réajustée avec succès',
        payment: updatedPayment,
      };
    });
  }

  /**
   * Crée une créance liée à une vente (mode partiel ou différé).
   */
  async createReceivableForSale(tenant: Tenant, dto: CreateReceivableFromSaleDto) {
    if (!Number.isFinite(dto.totalAmount) || dto.totalAmount <= 0) {
      throw new BadRequestException('Le montant total de la vente doit être positif');
    }
    if (!Number.isFinite(dto.amountPaidNow) || dto.amountPaidNow < 0) {
      throw new BadRequestException('Le montant déjà payé ne peut pas être négatif');
    }

    const [customer] = await this.db.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, dto.customerId), eq(customers.businessId, tenant.businessId)));

    if (!customer || !customer.isActive) {
      throw new NotFoundException('Un client actif identifié est obligatoire pour une vente à crédit');
    }

    const dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    if (dueDate && Number.isNaN(dueDate.getTime())) {
      throw new BadRequestException('La date d’échéance est invalide');
    }

    return this.db.db.transaction(async (tx) => {
      // The sale is the source of truth for tenant, customer and total. Lock it
      // so concurrent requests cannot create multiple receivables for one sale.
      const [sale] = await tx
        .select()
        .from(sales)
        .where(and(
          eq(sales.id, dto.saleId),
          eq(sales.businessId, tenant.businessId),
        ))
        .for('update');

      if (!sale) {
        throw new NotFoundException('Vente introuvable pour cette entreprise');
      }
      if (sale.status !== 'COMPLETED') {
        throw new BadRequestException('Une créance ne peut être créée que pour une vente terminée');
      }
      if (!sale.customerId || sale.customerId !== dto.customerId) {
        throw new BadRequestException('Le client de la créance doit correspondre au client de la vente');
      }

      const totalAmount = Number(sale.total);
      if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
        throw new BadRequestException('Le total de la vente est invalide');
      }
      if (Math.round(dto.totalAmount * 100) !== Math.round(totalAmount * 100)) {
        throw new BadRequestException('Le montant total fourni ne correspond pas au total enregistré de la vente');
      }
      if (dto.amountPaidNow >= totalAmount) {
        throw new BadRequestException('Le montant déjà payé doit être inférieur au total de la vente');
      }

      const [existingReceivable] = await tx
        .select({ id: receivables.id })
        .from(receivables)
        .where(and(
          eq(receivables.saleId, sale.id),
          eq(receivables.businessId, tenant.businessId),
        ))
        .limit(1);
      if (existingReceivable) {
        throw new ConflictException('Une créance existe déjà pour cette vente');
      }

      const remainingBalance = totalAmount - dto.amountPaidNow;
      const status = dto.amountPaidNow > 0 ? 'PARTIALLY_PAID' : 'PENDING';

      const [receivable] = await tx
        .insert(receivables)
        .values({
          businessId: tenant.businessId,
          locationId: sale.locationId,
          customerId: dto.customerId,
          saleId: sale.id,
          initialAmount: totalAmount.toFixed(2),
          paidAmount: dto.amountPaidNow.toFixed(2),
          remainingBalance: remainingBalance.toFixed(2),
          dueDate,
          status,
          notes: dto.notes || null,
        })
        .returning();

      if (!receivable) {
        throw new InternalServerErrorException('Échec de la génération de la créance');
      }

      // Enqueue notification outbox
      await this.outboxService.enqueue(tx, {
        businessId: tenant.businessId,
        eventType: NOVU_EVENT_TYPES.RECEIVABLE_CREATED,
        deduplicationKey: `receivable-created-${receivable.id}`,
        payload: {
          receivableId: receivable.id,
          saleId: receivable.saleId,
          initialAmount: dto.totalAmount,
          remainingBalance,
          customerName: customer.name,
          dueDate: dueDate ? dueDate.toISOString() : null,
          recipientId: tenant.userId,
        },
      });

      return receivable;
    });
  }

  /**
   * Liste les créances d'une entreprise avec détection dynamique des retards (OVERDUE).
   */
  async listReceivables(
    tenant: Tenant,
    options: { customerId?: string; status?: string; isOverdue?: boolean; limit?: number; offset?: number } = {},
  ) {
    const limit = Math.min(options.limit || 50, 100);
    const offset = options.offset || 0;

    const filters = [eq(receivables.businessId, tenant.businessId)];
    if (options.customerId) {
      filters.push(eq(receivables.customerId, options.customerId));
    }
    if (options.status) {
      filters.push(eq(receivables.status, options.status));
    }

    const rows = await this.db.db
      .select({
        id: receivables.id,
        businessId: receivables.businessId,
        customerId: receivables.customerId,
        saleId: receivables.saleId,
        initialAmount: receivables.initialAmount,
        paidAmount: receivables.paidAmount,
        remainingBalance: receivables.remainingBalance,
        dueDate: receivables.dueDate,
        status: receivables.status,
        notes: receivables.notes,
        createdAt: receivables.createdAt,
        updatedAt: receivables.updatedAt,
        customerName: customers.name,
        customerPhone: customers.phone,
      })
      .from(receivables)
      .innerJoin(customers, eq(receivables.customerId, customers.id))
      .where(and(...filters))
      .orderBy(desc(receivables.createdAt))
      .limit(limit)
      .offset(offset);

    const now = new Date();
    // Évaluation dynamique du statut OVERDUE
    const enriched = rows.map((r) => {
      const isOverdue =
        Number(r.remainingBalance) > 0 &&
        r.status !== 'PAID' &&
        r.status !== 'CANCELLED' &&
        r.dueDate !== null &&
        new Date(r.dueDate) < now;

      return {
        ...r,
        isOverdue,
        effectiveStatus: isOverdue ? 'OVERDUE' : r.status,
      };
    });

    if (options.isOverdue !== undefined) {
      return {
        data: enriched.filter((r) => r.isOverdue === options.isOverdue),
        limit,
        offset,
      };
    }

    return {
      data: enriched,
      limit,
      offset,
    };
  }

  /**
   * Récupère le détail d'une créance et l'historique complet de ses paiements.
   */
  async getReceivableDetail(tenant: Tenant, receivableId: string) {
    const [rec] = await this.db.db
      .select({
        id: receivables.id,
        businessId: receivables.businessId,
        customerId: receivables.customerId,
        saleId: receivables.saleId,
        initialAmount: receivables.initialAmount,
        paidAmount: receivables.paidAmount,
        remainingBalance: receivables.remainingBalance,
        dueDate: receivables.dueDate,
        status: receivables.status,
        notes: receivables.notes,
        createdAt: receivables.createdAt,
        updatedAt: receivables.updatedAt,
        customerName: customers.name,
        customerPhone: customers.phone,
      })
      .from(receivables)
      .innerJoin(customers, eq(receivables.customerId, customers.id))
      .where(
        and(
          eq(receivables.id, receivableId),
          eq(receivables.businessId, tenant.businessId),
        ),
      );

    if (!rec) {
      throw new NotFoundException('Créance introuvable');
    }

    const linkedPayments = await this.db.db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.receivableId, receivableId),
          eq(payments.businessId, tenant.businessId),
        ),
      )
      .orderBy(desc(payments.createdAt));

    const isOverdue =
      Number(rec.remainingBalance) > 0 &&
      rec.status !== 'PAID' &&
      rec.status !== 'CANCELLED' &&
      rec.dueDate !== null &&
      new Date(rec.dueDate) < new Date();

    return {
      ...rec,
      isOverdue,
      effectiveStatus: isOverdue ? 'OVERDUE' : rec.status,
      payments: linkedPayments,
    };
  }

  /**
   * Liste les paiements avec filtres et jointure client.
   */
  async listPayments(
    tenant: Tenant,
    options: { customerId?: string; saleId?: string; receivableId?: string; limit?: number; offset?: number } = {},
  ) {
    const limit = Math.min(options.limit || 50, 100);
    const offset = options.offset || 0;

    const filters = [eq(payments.businessId, tenant.businessId)];
    if (options.customerId) filters.push(eq(payments.customerId, options.customerId));
    if (options.saleId) filters.push(eq(payments.saleId, options.saleId));
    if (options.receivableId) filters.push(eq(payments.receivableId, options.receivableId));

    const data = await this.db.db
      .select({
        id: payments.id,
        businessId: payments.businessId,
        customerId: payments.customerId,
        saleId: payments.saleId,
        receivableId: payments.receivableId,
        amount: payments.amount,
        paymentMethod: payments.paymentMethod,
        transactionReference: payments.transactionReference,
        status: payments.status,
        receiptNumber: payments.receiptNumber,
        notes: payments.notes,
        createdAt: payments.createdAt,
        customerName: customers.name,
      })
      .from(payments)
      .innerJoin(customers, eq(payments.customerId, customers.id))
      .where(and(...filters))
      .orderBy(desc(payments.createdAt))
      .limit(limit)
      .offset(offset);

    return { data, limit, offset };
  }

  /**
   * Génère un reçu de paiement complet (utilisable pour impression ticket thermique 80mm ou PDF).
   */
  async getPaymentReceipt(tenant: Tenant, paymentId: string) {
    const [payment] = await this.db.db
      .select({
        id: payments.id,
        receiptNumber: payments.receiptNumber,
        amount: payments.amount,
        paymentMethod: payments.paymentMethod,
        transactionReference: payments.transactionReference,
        status: payments.status,
        notes: payments.notes,
        createdAt: payments.createdAt,
        customerId: payments.customerId,
        customerName: customers.name,
        customerPhone: customers.phone,
        receivableId: payments.receivableId,
        saleId: payments.saleId,
      })
      .from(payments)
      .innerJoin(customers, eq(payments.customerId, customers.id))
      .where(and(eq(payments.id, paymentId), eq(payments.businessId, tenant.businessId)));

    if (!payment) {
      throw new NotFoundException('Paiement introuvable');
    }

    const [business] = await this.db.db
      .select()
      .from(businesses)
      .where(eq(businesses.id, tenant.businessId));

    let remainingBalance: string | null = null;
    if (payment.receivableId) {
      const [rec] = await this.db.db
        .select({ remainingBalance: receivables.remainingBalance })
        .from(receivables)
        .where(eq(receivables.id, payment.receivableId));
      if (rec) remainingBalance = rec.remainingBalance;
    }

    return {
      receiptNumber: payment.receiptNumber,
      issuedAt: payment.createdAt,
      business: {
        id: business?.id,
        name: business?.name,
        currency: business?.currency || 'XOF',
        phone: business?.phone,
        address: business?.address,
      },
      customer: {
        id: payment.customerId,
        name: payment.customerName,
        phone: payment.customerPhone,
      },
      payment: {
        id: payment.id,
        amount: Number(payment.amount),
        currency: business?.currency || 'XOF',
        method: payment.paymentMethod,
        reference: payment.transactionReference,
        status: payment.status,
        notes: payment.notes,
      },
      receivable: payment.receivableId
        ? {
            id: payment.receivableId,
            remainingBalance: remainingBalance ? Number(remainingBalance) : 0,
          }
        : null,
    };
  }
}
