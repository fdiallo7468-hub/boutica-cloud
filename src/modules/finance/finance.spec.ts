import { BadRequestException, ConflictException } from '@nestjs/common';
import { FinanceService } from './finance.service';
import { PaymentMethodEnum } from './dto/finance.dto';
import { Tenant } from '../auth/tenant.type';

describe('Finance Module — Payments, Receivables & Settlement Modes (Part 6)', () => {
  let mockDb: any;
  let mockOutboxService: any;
  let mockAuditEventsService: any;
  let financeService: FinanceService;

  const mockTenant: Tenant = {
    userId: 'user-owner-1',
    businessId: 'biz-test-1',
    role: 'OWNER',
  };

  const mockCustomer = {
    id: 'cust-1',
    businessId: 'biz-test-1',
    name: 'Entreprise Diallo BTP',
    phone: '+221770000000',
    isActive: true,
  };

  beforeEach(() => {
    mockOutboxService = {
      enqueue: jest.fn().mockResolvedValue({ id: 'outbox-1', deduplicationKey: 'key-1' }),
    };
    mockAuditEventsService = {
      appendInTransaction: jest.fn().mockResolvedValue('audit-event-1'),
    };

    mockDb = {
      db: {
        select: jest.fn(),
        insert: jest.fn(),
        update: jest.fn(),
        transaction: jest.fn(async (cb) => cb(mockDb.db)),
      },
    };

    financeService = new FinanceService(mockDb, mockOutboxService, mockAuditEventsService);
  });

  describe('Settlement Modes (Integral, Partial & Deferred)', () => {
    it('creates a receivable for partial sale (Mode B: 40 000 paid, 60 000 credit)', async () => {
      // 1. Customer lookup
      mockDb.db.select.mockReturnValueOnce({
        from: () => ({
          where: () => Promise.resolve([mockCustomer]),
        }),
      });

      // 2. Insert receivable
      mockDb.db.select
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({
              for: () => Promise.resolve([{
                id: 'sale-1',
                businessId: mockTenant.businessId,
                customerId: mockCustomer.id,
                total: '100000.00',
                status: 'COMPLETED',
              }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({ limit: () => Promise.resolve([]) }),
          }),
        });

      mockDb.db.insert.mockReturnValueOnce({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([
            {
              id: 'rec-1',
              businessId: mockTenant.businessId,
              customerId: mockCustomer.id,
              saleId: 'sale-1',
              initialAmount: '100000.00',
              paidAmount: '40000.00',
              remainingBalance: '60000.00',
              status: 'PARTIALLY_PAID',
            },
          ]),
        }),
      });

      const rec = await financeService.createReceivableForSale(mockTenant, {
        saleId: 'sale-1',
        customerId: mockCustomer.id,
        totalAmount: 100000,
        amountPaidNow: 40000,
        dueDate: '2026-12-01T00:00:00.000Z',
      });

      expect(rec.remainingBalance).toBe('60000.00');
      expect(rec.status).toBe('PARTIALLY_PAID');
      expect(mockOutboxService.enqueue).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'receivable.created' }),
      );
    });

    it('creates a full credit receivable for deferred sale (Mode C: 0 paid, 100 000 credit)', async () => {
      mockDb.db.select.mockReturnValueOnce({
        from: () => ({
          where: () => Promise.resolve([mockCustomer]),
        }),
      });

      mockDb.db.select
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({
              for: () => Promise.resolve([{
                id: 'sale-2',
                businessId: mockTenant.businessId,
                customerId: mockCustomer.id,
                total: '100000.00',
                status: 'COMPLETED',
              }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({ limit: () => Promise.resolve([]) }),
          }),
        });

      mockDb.db.insert.mockReturnValueOnce({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([
            {
              id: 'rec-deferred',
              businessId: mockTenant.businessId,
              customerId: mockCustomer.id,
              saleId: 'sale-2',
              initialAmount: '100000.00',
              paidAmount: '0.00',
              remainingBalance: '100000.00',
              status: 'PENDING',
            },
          ]),
        }),
      });

      const rec = await financeService.createReceivableForSale(mockTenant, {
        saleId: 'sale-2',
        customerId: mockCustomer.id,
        totalAmount: 100000,
        amountPaidNow: 0,
      });

      expect(rec.remainingBalance).toBe('100000.00');
      expect(rec.status).toBe('PENDING');
    });
  });

  describe('Payment Execution, Balance Updates & Overpayment Guard', () => {
    it('records payment, decrements receivable balance and marks PAID when balance reaches 0', async () => {
      const existingReceivable = {
        id: 'rec-active',
        businessId: mockTenant.businessId,
        customerId: mockCustomer.id,
        saleId: 'sale-1',
        initialAmount: '100000.00',
        paidAmount: '40000.00',
        remainingBalance: '60000.00',
        status: 'PARTIALLY_PAID',
      };

      // 1. Customer check
      mockDb.db.select
        .mockReturnValueOnce({
          from: () => ({
            where: () => Promise.resolve([mockCustomer]),
          }),
        })
        // 2. Receivable check in tx
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({ for: () => Promise.resolve([existingReceivable]) }),
          }),
        })
        // 3. Default location fallback when the receivable fixture has no location.
        .mockReturnValueOnce({
          from: () => ({ where: () => Promise.resolve([{ id: 'location-main' }]) }),
        });

      // 3. Insert payment
      mockDb.db.insert.mockReturnValueOnce({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([
            {
              id: 'pay-final',
              businessId: mockTenant.businessId,
              customerId: mockCustomer.id,
              receivableId: 'rec-active',
              amount: '60000.00',
              paymentMethod: 'WAVE',
              receiptNumber: 'REC-20261102-1234',
              status: 'CONFIRMED',
            },
          ]),
        }),
      });

      // 4. Update receivable to PAID
      const updateSetMock = jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      });
      mockDb.db.update.mockReturnValueOnce({ set: updateSetMock });

      const res = await financeService.recordPayment(mockTenant, {
        customerId: mockCustomer.id,
        receivableId: 'rec-active',
        amount: 60000,
        paymentMethod: PaymentMethodEnum.WAVE,
        transactionReference: 'WAVE-TX-998877',
      });

      expect(res.amount).toBe('60000.00');
      expect(res.receivableSettled).toBe(true);

      // Verify receivable marked PAID
      expect(updateSetMock).toHaveBeenCalledWith(
        expect.objectContaining({
          paidAmount: '100000.00',
          remainingBalance: '0.00',
          status: 'PAID',
        }),
      );

      // Verify payment.received and receivable.settled enqueued
      expect(mockOutboxService.enqueue).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'payment.received' }),
      );
      expect(mockOutboxService.enqueue).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'receivable.settled' }),
      );
    });

    it('rejects overpayment exceeding receivable remaining balance', async () => {
      const existingReceivable = {
        id: 'rec-active',
        businessId: mockTenant.businessId,
        customerId: mockCustomer.id,
        remainingBalance: '30000.00',
        status: 'PARTIALLY_PAID',
      };

      mockDb.db.select
        .mockReturnValueOnce({
          from: () => ({ where: () => Promise.resolve([mockCustomer]) }),
        })
        .mockReturnValueOnce({
          from: () => ({ where: () => ({ for: () => Promise.resolve([existingReceivable]) }) }),
        });

      await expect(
        financeService.recordPayment(mockTenant, {
          customerId: mockCustomer.id,
          receivableId: 'rec-active',
          amount: 50000, // Exceeds 30000
          paymentMethod: PaymentMethodEnum.ORANGE_MONEY,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects payments with zero or negative amounts', async () => {
      await expect(
        financeService.recordPayment(mockTenant, {
          customerId: mockCustomer.id,
          amount: 0,
          paymentMethod: PaymentMethodEnum.CASH,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Payment Cancellation & Audit Restoration', () => {
    it('cancels confirmed payment, restores receivable balance and logs cancellation reason', async () => {
      const confirmedPayment = {
        id: 'pay-to-cancel',
        businessId: mockTenant.businessId,
        amount: '20000.00',
        receivableId: 'rec-1',
        status: 'CONFIRMED',
        receiptNumber: 'REC-123',
      };

      const linkedReceivable = {
        id: 'rec-1',
        initialAmount: '100000.00',
        paidAmount: '80000.00',
        remainingBalance: '20000.00',
        status: 'PARTIALLY_PAID',
      };

      // 1. Payment lookup
      mockDb.db.select
        .mockReturnValueOnce({
          from: () => ({ where: () => ({ for: () => Promise.resolve([confirmedPayment]) }) }),
        })
        // 2. Linked receivable lookup
        .mockReturnValueOnce({
          from: () => ({ where: () => ({ for: () => Promise.resolve([linkedReceivable]) }) }),
        });

      // Update payment to CANCELLED
      mockDb.db.update
        .mockReturnValueOnce({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ ...confirmedPayment, status: 'CANCELLED' }]),
            }),
          }),
        })
        // Update receivable to restored balance
        .mockReturnValueOnce({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([]),
          }),
        });

      // Insert audit cancellation
      mockDb.db.insert.mockReturnValue({
        values: jest.fn().mockResolvedValue([]),
      });

      const res = await financeService.cancelPayment(mockTenant, 'pay-to-cancel', {
        reason: 'Erreur de saisie de caisse au comptoir',
      });

      expect(res.success).toBe(true);
      expect(res.payment?.status).toBe('CANCELLED');
      expect(mockDb.db.insert).toHaveBeenCalled(); // Payment cancellation audit log
      expect(mockOutboxService.enqueue).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'payment.cancelled' }),
      );
    });

    it('rejects cancelling an already cancelled payment', async () => {
      mockDb.db.select.mockReturnValueOnce({
        from: () => ({
          where: () => ({ for: () => Promise.resolve([{ id: 'pay-already-cancelled', status: 'CANCELLED' }]) }),
        }),
      });

      await expect(
        financeService.cancelPayment(mockTenant, 'pay-already-cancelled', {
          reason: 'Double click',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
