import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DatabaseService } from '../../src/infrastructure/database/database';
import { createTestApp, registerBusiness, resetDatabase } from '../utils/test-app';
import { suppliers } from '../../src/infrastructure/database/schema';

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

});
