import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DatabaseService } from '../../src/infrastructure/database/database';
import { adjustStock, createProductWithVariant, createTestApp, registerBusiness, resetDatabase } from '../utils/test-app';
import { accountingEntries, suppliers } from '../../src/infrastructure/database/schema';
import { eq } from 'drizzle-orm';

describe('Accounting operational posting (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const setup = await createTestApp();
    app = setup.app;
  });

  beforeEach(async () => resetDatabase(app.get(DatabaseService)));

  afterAll(async () => {
    await app.close();
  });

  it('posts an expense atomically using an explicitly configured mapping', async () => {
    const { accessToken } = await registerBusiness(app, 'Accounting expense mapping');
    const auth = { Authorization: `Bearer ${accessToken}` };
    const year = new Date().getUTCFullYear();
    const date = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    await request(app.getHttpServer()).put('/api/v1/accounting/profile').set(auth).send({}).expect(200);
    const fiscalYear = await request(app.getHttpServer()).post('/api/v1/accounting/fiscal-years')
      .set(auth).send({ code: `FY-${year}`, label: `Exercice ${year}`, startDate: date, endDate }).expect(201);
    await request(app.getHttpServer()).post('/api/v1/accounting/periods').set(auth)
      .send({ fiscalYearId: fiscalYear.body.id, code: `P-${year}`, label: `Période ${year}`, startDate: date, endDate })
      .expect(201);

    const journal = await request(app.getHttpServer()).post('/api/v1/accounting/journals').set(auth)
      .send({ code: 'CAI', label: 'Journal de caisse', journalType: 'CASH', sequencePrefix: 'CAI-' }).expect(201);
    const expenseAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '6', label: 'Charges', class: 6, normalBalance: 'DEBIT', isPostable: true }).expect(201);
    const cashAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '5', label: 'Trésorerie', class: 5, normalBalance: 'DEBIT', isPostable: true }).expect(201);

    await request(app.getHttpServer()).put('/api/v1/accounting/event-mappings/expenses/transport').set(auth)
      .send({
        journalId: journal.body.id,
        debitAccountId: expenseAccount.body.id,
        creditAccountId: cashAccount.body.id,
      }).expect(200);

    const expense = await request(app.getHttpServer()).post('/api/v1/expenses').set(auth)
      .send({ category: 'Transport', amount: 12500, description: 'Livraison locale' }).expect(201);
    expect(expense.body.accounting).toMatchObject({ status: 'POSTED', entryNumber: 'CAI-000001' });

    const ledger = await request(app.getHttpServer())
      .get(`/api/v1/accounting/accounts/${expenseAccount.body.id}/ledger`).set(auth).expect(200);
    expect(ledger.body).toHaveLength(1);
    expect(ledger.body[0]).toMatchObject({ debit: '12500.00', credit: '0.00', balance: '12500.00' });

    const trialBalance = await request(app.getHttpServer()).get('/api/v1/accounting/trial-balance').set(auth).expect(200);
    expect(trialBalance.body.totals).toMatchObject({ debit: '12500.00', credit: '12500.00', balanced: true });
  });

  it('does not invent account mappings when a category is not configured', async () => {
    const { accessToken } = await registerBusiness(app, 'Unmapped accounting expense');
    const expense = await request(app.getHttpServer()).post('/api/v1/expenses')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ category: 'Divers', amount: 500, description: 'Petite dépense' }).expect(201);
    expect(expense.body.accounting).toMatchObject({ status: 'NOT_CONFIGURED', entryId: null });
  });

  it('posts a completed sale as a balanced multi-line entry from persisted sale and cost snapshots', async () => {
    const { accessToken } = await registerBusiness(app, 'Accounting multi-line sale');
    const auth = { Authorization: `Bearer ${accessToken}` };
    const year = new Date().getUTCFullYear();
    const date = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    await request(app.getHttpServer()).put('/api/v1/accounting/profile').set(auth).send({}).expect(200);
    const fiscalYear = await request(app.getHttpServer()).post('/api/v1/accounting/fiscal-years').set(auth)
      .send({ code: `FY-${year}`, label: `Exercice ${year}`, startDate: date, endDate }).expect(201);
    await request(app.getHttpServer()).post('/api/v1/accounting/periods').set(auth)
      .send({ fiscalYearId: fiscalYear.body.id, code: `P-${year}`, label: `Période ${year}`, startDate: date, endDate })
      .expect(201);
    const journal = await request(app.getHttpServer()).post('/api/v1/accounting/journals').set(auth)
      .send({ code: 'VTE', label: 'Journal des ventes', journalType: 'SALES', sequencePrefix: 'VTE-' }).expect(201);

    const receivableAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '411', label: 'Clients', class: 4, normalBalance: 'DEBIT', isPostable: true }).expect(201);
    const discountAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '709', label: 'Rabais et remises accordés', class: 7, normalBalance: 'DEBIT', isPostable: true }).expect(201);
    const revenueAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '701', label: 'Ventes', class: 7, normalBalance: 'CREDIT', isPostable: true }).expect(201);
    const cogsAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '603', label: 'Variation / coût des marchandises', class: 6, normalBalance: 'DEBIT', isPostable: true }).expect(201);
    const inventoryAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '31', label: 'Stocks de marchandises', class: 3, normalBalance: 'CREDIT', isPostable: true }).expect(201);
    const customer = await request(app.getHttpServer()).post('/api/v1/customers').set(auth)
      .send({ name: 'Client comptable' }).expect(201);

    await request(app.getHttpServer()).put('/api/v1/accounting/event-mappings/SALE/default').set(auth).send({
      journalId: journal.body.id,
      lines: [
        { accountId: receivableAccount.body.id, side: 'DEBIT', amountBasis: 'SALE_TOTAL', auxiliaryType: 'CUSTOMER' },
        { accountId: discountAccount.body.id, side: 'DEBIT', amountBasis: 'SALE_DISCOUNT' },
        { accountId: revenueAccount.body.id, side: 'CREDIT', amountBasis: 'SALE_SUBTOTAL' },
        { accountId: cogsAccount.body.id, side: 'DEBIT', amountBasis: 'SALE_COST_AT_SALE' },
        { accountId: inventoryAccount.body.id, side: 'CREDIT', amountBasis: 'SALE_COST_AT_SALE' },
      ],
    }).expect(200);

    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 100, purchasePrice: 40 });
    await adjustStock(app, accessToken, variantId, 10);
    const sale = await request(app.getHttpServer()).post('/api/v1/sales').set(auth).send({
      customerId: customer.body.id,
      discount: 20,
      items: [{ variantId, quantity: 2 }],
    }).expect(201);

    expect(sale.body).toMatchObject({
      subtotal: '200.00',
      discount: '20.00',
      total: '180.00',
      accounting: { status: 'POSTED' },
    });
    const trialBalance = await request(app.getHttpServer()).get('/api/v1/accounting/trial-balance').set(auth).expect(200);
    expect(trialBalance.body.totals).toMatchObject({ debit: '280.00', credit: '280.00', balanced: true });
  });

  it('posts purchases, settlements and returns and reverses a cancelled payment atomically', async () => {
    const { accessToken } = await registerBusiness(app, 'Accounting operational events');
    const auth = { Authorization: `Bearer ${accessToken}` };
    const year = new Date().getUTCFullYear();
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;
    await request(app.getHttpServer()).put('/api/v1/accounting/profile').set(auth).send({}).expect(200);
    const fiscalYear = await request(app.getHttpServer()).post('/api/v1/accounting/fiscal-years').set(auth)
      .send({ code: `FY-${year}`, label: `Exercice ${year}`, startDate, endDate }).expect(201);
    await request(app.getHttpServer()).post('/api/v1/accounting/periods').set(auth)
      .send({ fiscalYearId: fiscalYear.body.id, code: `P-${year}`, label: `Période ${year}`, startDate, endDate }).expect(201);

    const purchaseJournal = await request(app.getHttpServer()).post('/api/v1/accounting/journals').set(auth)
      .send({ code: 'ACH', label: 'Journal des achats', journalType: 'PURCHASE', sequencePrefix: 'ACH-' }).expect(201);
    const salesJournal = await request(app.getHttpServer()).post('/api/v1/accounting/journals').set(auth)
      .send({ code: 'VTE', label: 'Journal des ventes', journalType: 'SALES', sequencePrefix: 'VTE-' }).expect(201);
    const cashJournal = await request(app.getHttpServer()).post('/api/v1/accounting/journals').set(auth)
      .send({ code: 'CAI', label: 'Journal de caisse', journalType: 'CASH', sequencePrefix: 'CAI-' }).expect(201);

    const inventoryAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '31', label: 'Stocks', class: 3, normalBalance: 'DEBIT', isPostable: true }).expect(201);
    const supplierAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '401', label: 'Fournisseurs', class: 4, normalBalance: 'CREDIT', isPostable: true }).expect(201);
    const customerAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '411', label: 'Clients', class: 4, normalBalance: 'DEBIT', isPostable: true }).expect(201);
    const cashAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '571', label: 'Caisse', class: 5, normalBalance: 'DEBIT', isPostable: true }).expect(201);
    const revenueAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '701', label: 'Ventes', class: 7, normalBalance: 'CREDIT', isPostable: true }).expect(201);
    const cogsAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '603', label: 'Coût des marchandises vendues', class: 6, normalBalance: 'DEBIT', isPostable: true }).expect(201);
    const salesReturnAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '709', label: 'Retours et rabais', class: 7, normalBalance: 'DEBIT', isPostable: true }).expect(201);

    const supplier = await request(app.getHttpServer()).post('/api/v1/suppliers').set(auth)
      .send({ name: 'Fournisseur test comptable' }).expect(201);
    const customer = await request(app.getHttpServer()).post('/api/v1/customers').set(auth)
      .send({ name: 'Client test comptable' }).expect(201);

    await request(app.getHttpServer()).put('/api/v1/accounting/event-mappings/PURCHASE/default').set(auth).send({
      journalId: purchaseJournal.body.id,
      lines: [
        { accountId: inventoryAccount.body.id, side: 'DEBIT', amountBasis: 'PURCHASE_TOTAL' },
        { accountId: supplierAccount.body.id, side: 'CREDIT', amountBasis: 'PURCHASE_TOTAL', auxiliaryType: 'SUPPLIER' },
      ],
    }).expect(200);
    await request(app.getHttpServer()).put('/api/v1/accounting/event-mappings/SALE/default').set(auth).send({
      journalId: salesJournal.body.id,
      lines: [
        { accountId: customerAccount.body.id, side: 'DEBIT', amountBasis: 'SALE_TOTAL', auxiliaryType: 'CUSTOMER' },
        { accountId: revenueAccount.body.id, side: 'CREDIT', amountBasis: 'SALE_TOTAL' },
      ],
    }).expect(200);
    await request(app.getHttpServer()).put('/api/v1/accounting/event-mappings/PAYMENT/cash:settlement').set(auth).send({
      journalId: cashJournal.body.id,
      lines: [
        { accountId: cashAccount.body.id, side: 'DEBIT', amountBasis: 'PAYMENT_AMOUNT' },
        { accountId: customerAccount.body.id, side: 'CREDIT', amountBasis: 'PAYMENT_AMOUNT', auxiliaryType: 'CUSTOMER' },
      ],
    }).expect(200);
    await request(app.getHttpServer()).put('/api/v1/accounting/event-mappings/RETURN/default').set(auth).send({
      journalId: salesJournal.body.id,
      lines: [
        { accountId: salesReturnAccount.body.id, side: 'DEBIT', amountBasis: 'RETURN_TOTAL' },
        { accountId: customerAccount.body.id, side: 'CREDIT', amountBasis: 'RETURN_TOTAL', auxiliaryType: 'CUSTOMER' },
        { accountId: inventoryAccount.body.id, side: 'DEBIT', amountBasis: 'RETURN_RESTOCK_COST' },
        { accountId: cogsAccount.body.id, side: 'CREDIT', amountBasis: 'RETURN_RESTOCK_COST' },
      ],
    }).expect(200);

    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 100, purchasePrice: 40 });
    const purchase = await request(app.getHttpServer()).post('/api/v1/purchases/receive').set(auth).send({
      supplierId: supplier.body.id,
      items: [{ variantId, quantity: 3, unitPrice: 30 }],
    }).expect(201);
    expect(purchase.body).toMatchObject({ total: '90.00', accounting: { status: 'POSTED' } });

    const sale = await request(app.getHttpServer()).post('/api/v1/sales').set(auth).send({
      customerId: customer.body.id,
      items: [{ variantId, quantity: 2 }],
    }).expect(201);
    expect(sale.body.accounting.status).toBe('POSTED');

    const receivable = await request(app.getHttpServer()).post('/api/v1/receivables').set(auth).send({
      customerId: customer.body.id,
      saleId: sale.body.id,
      totalAmount: 200,
      amountPaidNow: 50,
      paymentMethod: 'CASH',
    }).expect(201);
    expect(receivable.body).toMatchObject({
      paidAmount: '50.00',
      remainingBalance: '150.00',
      initialPayment: { accounting: { status: 'POSTED' } },
    });
    const paymentId = receivable.body.initialPayment.id;

    const cancelledPayment = await request(app.getHttpServer()).post(`/api/v1/payments/${paymentId}/cancel`).set(auth)
      .send({ reason: 'Annulation de test' }).expect(200);
    expect(cancelledPayment.body.accounting).toMatchObject({ status: 'REVERSED' });

    const returned = await request(app.getHttpServer()).post('/api/v1/returns').set(auth).send({
      saleId: sale.body.id,
      items: [{ saleItemId: sale.body.items[0].id, quantity: 1, condition: 'RESTOCK' }],
      reason: 'Retour de test',
    }).expect(201);
    expect(returned.body).toMatchObject({ total: '100.00', accounting: { status: 'POSTED' } });

    const trialBalance = await request(app.getHttpServer()).get('/api/v1/accounting/trial-balance').set(auth).expect(200);
    expect(trialBalance.body.totals.debit).toBe(trialBalance.body.totals.credit);
    expect(trialBalance.body.totals.balanced).toBe(true);
  });

  it('reconciles opening balances, customer/supplier auxiliaries and the trial balance', async () => {
    const { accessToken, businessId } = await registerBusiness(app, 'Accounting opening balance');
    const auth = { Authorization: `Bearer ${accessToken}` };
    const year = new Date().getUTCFullYear();
    const date = `${year}-01-01`;
    const endDate = `${year}-12-31`;
    await request(app.getHttpServer()).put('/api/v1/accounting/profile').set(auth).send({}).expect(200);
    const fiscalYear = await request(app.getHttpServer()).post('/api/v1/accounting/fiscal-years').set(auth)
      .send({ code: `FY-${year}`, label: `Exercice ${year}`, startDate: date, endDate }).expect(201);
    const period = await request(app.getHttpServer()).post('/api/v1/accounting/periods').set(auth)
      .send({ fiscalYearId: fiscalYear.body.id, code: `P-${year}`, label: `Période ${year}`, startDate: date, endDate }).expect(201);
    const journal = await request(app.getHttpServer()).post('/api/v1/accounting/journals').set(auth)
      .send({ code: 'AN', label: 'À-nouveaux', journalType: 'OPENING', sequencePrefix: 'AN-' }).expect(201);
    const customerAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '411', label: 'Clients', class: 4, normalBalance: 'DEBIT', isPostable: true }).expect(201);
    const equityAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '101', label: 'Capital', class: 1, normalBalance: 'CREDIT', isPostable: true }).expect(201);
    const customer = await request(app.getHttpServer()).post('/api/v1/customers').set(auth)
      .send({ name: 'Client auxiliaire' }).expect(201);
    const customerOpeningPayload = {
      journalId: journal.body.id, periodId: period.body.id, entryDate: date,
      description: 'À-nouveaux exercice', idempotencyKey: 'opening-fy-test',
      lines: [
        { accountId: customerAccount.body.id, debit: '25000.00', auxiliaryType: 'CUSTOMER' as const, auxiliaryId: customer.body.id },
        { accountId: equityAccount.body.id, credit: '25000.00' },
      ],
    };
    const opening = await request(app.getHttpServer()).post('/api/v1/accounting/opening-balances').set(auth)
      .send(customerOpeningPayload).expect(201);
    expect(opening.body.status).toBe('POSTED');
    const openingRetry = await request(app.getHttpServer()).post('/api/v1/accounting/opening-balances').set(auth)
      .send(customerOpeningPayload).expect(201);
    expect(openingRetry.body.id).toBe(opening.body.id);

    const [supplier] = await app.get(DatabaseService).db.insert(suppliers).values({
      businessId, name: 'Fournisseur auxiliaire',
    }).returning();
    if (!supplier) throw new Error('Supplier auxiliary fixture could not be created');
    const supplierAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '401', label: 'Fournisseurs', class: 4, normalBalance: 'CREDIT', isPostable: true }).expect(201);
    const supplierOpening = await request(app.getHttpServer()).post('/api/v1/accounting/opening-balances').set(auth)
      .send({
        journalId: journal.body.id, periodId: period.body.id, entryDate: date,
        description: 'Solde fournisseur à-nouveaux', idempotencyKey: 'opening-fy-supplier',
        lines: [
          { accountId: supplierAccount.body.id, credit: '10000.00', auxiliaryType: 'SUPPLIER', auxiliaryId: supplier.id },
          { accountId: equityAccount.body.id, debit: '10000.00' },
        ],
      }).expect(201);
    expect(supplierOpening.body.status).toBe('POSTED');

    const customerLedger = await request(app.getHttpServer())
      .get(`/api/v1/accounting/customers/${customer.body.id}/ledger`).set(auth).expect(200);
    expect(customerLedger.body).toHaveLength(1);
    expect(customerLedger.body[0]).toMatchObject({ debit: '25000.00', credit: '0.00', balance: '25000.00' });
    const supplierLedger = await request(app.getHttpServer())
      .get(`/api/v1/accounting/suppliers/${supplier.id}/ledger`).set(auth).expect(200);
    expect(supplierLedger.body).toHaveLength(1);
    expect(supplierLedger.body[0]).toMatchObject({ debit: '0.00', credit: '10000.00', balance: '-10000.00' });

    const generalLedger = await request(app.getHttpServer())
      .get(`/api/v1/accounting/accounts/${customerAccount.body.id}/ledger`).set(auth).expect(200);
    expect(generalLedger).toBeDefined();
    expect(generalLedger.body).toHaveLength(1);
    expect(generalLedger.body[0].balance).toBe('25000.00');

    const trialBalance = await request(app.getHttpServer()).get('/api/v1/accounting/trial-balance').set(auth).expect(200);
    expect(trialBalance.body.totals).toMatchObject({ debit: '35000.00', credit: '35000.00', balanced: true });
    expect(trialBalance.body.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: customerAccount.body.id, debit: '25000.00', credit: '0.00' }),
      expect.objectContaining({ accountId: supplierAccount.body.id, debit: '0.00', credit: '10000.00' }),
    ]));

    const foreignBusiness = await registerBusiness(app, 'Foreign accounting auxiliary');
    const foreignCustomer = await request(app.getHttpServer()).post('/api/v1/customers')
      .set('Authorization', `Bearer ${foreignBusiness.accessToken}`).send({ name: 'Client autre entreprise' }).expect(201);
    await request(app.getHttpServer()).post('/api/v1/accounting/opening-balances').set(auth)
      .send({
        journalId: journal.body.id, periodId: period.body.id, entryDate: date,
        description: 'Tentative de tiers inter-entreprise', idempotencyKey: 'foreign-auxiliary-test',
        lines: [
          { accountId: customerAccount.body.id, debit: '100.00', auxiliaryType: 'CUSTOMER', auxiliaryId: foreignCustomer.body.id },
          { accountId: equityAccount.body.id, credit: '100.00' },
        ],
      }).expect(400);
  });

  it('enforces fiscal-year, period and account hierarchy invariants', async () => {
    const { accessToken } = await registerBusiness(app, 'Accounting foundations invariants');
    const auth = { Authorization: `Bearer ${accessToken}` };
    const year = new Date().getUTCFullYear();
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;
    await request(app.getHttpServer()).put('/api/v1/accounting/profile').set(auth).send({}).expect(200);

    const fiscalYear = await request(app.getHttpServer()).post('/api/v1/accounting/fiscal-years').set(auth)
      .send({ code: `FY-${year}`, label: `Exercice ${year}`, startDate, endDate }).expect(201);
    await request(app.getHttpServer()).post('/api/v1/accounting/fiscal-years').set(auth)
      .send({ code: `FY-${year}-OVERLAP`, label: 'Exercice chevauchant', startDate: `${year}-06-01`, endDate })
      .expect(409);

    const period = await request(app.getHttpServer()).post('/api/v1/accounting/periods').set(auth)
      .send({ fiscalYearId: fiscalYear.body.id, code: `P-${year}`, label: `Période ${year}`, startDate, endDate }).expect(201);
    await request(app.getHttpServer()).post('/api/v1/accounting/periods').set(auth)
      .send({ fiscalYearId: fiscalYear.body.id, code: `P-${year}-OVERLAP`, label: 'Période chevauchante',
        startDate: `${year}-02-01`, endDate: `${year}-03-01` }).expect(409);

    const parent = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '41', label: 'Tiers', class: 4, normalBalance: 'DEBIT', isPostable: false }).expect(201);
    await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '411', label: 'Clients', class: 4, parentAccountId: parent.body.id,
        normalBalance: 'DEBIT', isPostable: true }).expect(201);
    await request(app.getHttpServer()).patch(`/api/v1/accounting/accounts/${parent.body.id}`).set(auth)
      .send({ isPostable: true }).expect(409);

    await request(app.getHttpServer()).patch(`/api/v1/accounting/periods/${period.body.id}/status`).set(auth)
      .send({ status: 'CLOSED' }).expect(200);
    await request(app.getHttpServer()).patch(`/api/v1/accounting/periods/${period.body.id}/status`).set(auth)
      .send({ status: 'LOCKED' }).expect(200);
    await request(app.getHttpServer()).patch(`/api/v1/accounting/periods/${period.body.id}/status`).set(auth)
      .send({ status: 'CLOSED' }).expect(409);
  });

  it('posts idempotently, reverses once and protects posted entries at database level', async () => {
    const { accessToken } = await registerBusiness(app, 'Accounting reversal invariants');
    const auth = { Authorization: `Bearer ${accessToken}` };
    const year = new Date().getUTCFullYear();
    const date = `${year}-01-01`;
    const endDate = `${year}-12-31`;
    await request(app.getHttpServer()).put('/api/v1/accounting/profile').set(auth).send({}).expect(200);
    const fiscalYear = await request(app.getHttpServer()).post('/api/v1/accounting/fiscal-years').set(auth)
      .send({ code: `FY-${year}`, label: `Exercice ${year}`, startDate: date, endDate }).expect(201);
    const period = await request(app.getHttpServer()).post('/api/v1/accounting/periods').set(auth)
      .send({ fiscalYearId: fiscalYear.body.id, code: `P-${year}`, label: `Période ${year}`, startDate: date, endDate }).expect(201);
    const journal = await request(app.getHttpServer()).post('/api/v1/accounting/journals').set(auth)
      .send({ code: 'OD', label: 'Opérations diverses', journalType: 'GENERAL', sequencePrefix: 'OD-' }).expect(201);
    const debitAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '411', label: 'Clients', class: 4, normalBalance: 'DEBIT', isPostable: true }).expect(201);
    const creditAccount = await request(app.getHttpServer()).post('/api/v1/accounting/accounts').set(auth)
      .send({ accountNumber: '101', label: 'Capital', class: 1, normalBalance: 'CREDIT', isPostable: true }).expect(201);
    const payload = {
      journalId: journal.body.id, periodId: period.body.id, entryDate: date,
      description: 'Écriture de test', idempotencyKey: 'entry-idempotency-test',
      lines: [
        { accountId: debitAccount.body.id, debit: '100.00' },
        { accountId: creditAccount.body.id, credit: '100.00' },
      ],
    };
    const posted = await request(app.getHttpServer()).post('/api/v1/accounting/entries').set(auth).send(payload).expect(201);
    expect(posted.body.status).toBe('POSTED');
    const retry = await request(app.getHttpServer()).post('/api/v1/accounting/entries').set(auth).send(payload).expect(201);
    expect(retry.body.id).toBe(posted.body.id);
    await request(app.getHttpServer()).post('/api/v1/accounting/entries').set(auth)
      .send({ ...payload, lines: [
        { accountId: debitAccount.body.id, debit: '101.00' },
        { accountId: creditAccount.body.id, credit: '101.00' },
      ] }).expect(409);

    const reversal = await request(app.getHttpServer()).post(`/api/v1/accounting/entries/${posted.body.id}/reverse`)
      .set(auth).send({ periodId: period.body.id, entryDate: date }).expect(201);
    expect(reversal.body.status).toBe('POSTED');
    await request(app.getHttpServer()).post(`/api/v1/accounting/entries/${posted.body.id}/reverse`)
      .set(auth).send({ periodId: period.body.id, entryDate: date }).expect(409);

    await expect(app.get(DatabaseService).db.update(accountingEntries).set({ description: 'Tentative de modification' })
      .where(eq(accountingEntries.id, posted.body.id))).rejects.toThrow();

    const ledger = await request(app.getHttpServer()).get(`/api/v1/accounting/accounts/${debitAccount.body.id}/ledger`)
      .set(auth).expect(200);
    expect(ledger.body).toHaveLength(2);
    expect(ledger.body[1].balance).toBe('0.00');
    const trialBalance = await request(app.getHttpServer()).get('/api/v1/accounting/trial-balance').set(auth).expect(200);
    expect(trialBalance.body.totals).toMatchObject({ debit: '200.00', credit: '200.00', balanced: true });
  });

});
