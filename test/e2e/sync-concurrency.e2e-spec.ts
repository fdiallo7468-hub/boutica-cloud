import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { customers } from '../../src/infrastructure/database/schema';
import { DatabaseService } from '../../src/infrastructure/database/database';
import { createTestApp, registerBusiness, resetDatabase } from '../utils/test-app';

describe('Sync idempotency under PostgreSQL concurrency (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseService;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  it('commits one customer when the same operation is pushed concurrently twice', async () => {
    const business = await registerBusiness(app, 'Concurrent Sync Shop');
    const deviceId = 'concurrency-test-device';
    await request(app.getHttpServer())
      .post('/api/v1/sync/devices/register')
      .set('Authorization', `Bearer ${business.accessToken}`)
      .send({ deviceId, deviceType: 'DESKTOP', deviceName: 'CI device', appVersion: 'ci' })
      .expect(200);

    const customerId = randomUUID();
    const operation = {
      clientOperationId: 'same-operation-id-for-two-requests',
      operationType: 'CREATE_CUSTOMER',
      clientTimestamp: new Date().toISOString(),
      payload: { id: customerId, name: 'Concurrent customer' },
    };
    const push = () => request(app.getHttpServer())
      .post('/api/v1/sync/push')
      .set('Authorization', `Bearer ${business.accessToken}`)
      .send({ deviceId, operations: [operation] })
      .expect(200);

    const [first, second] = await Promise.all([push(), push()]);
    expect(first.body.results[0].status).toBe('COMMITTED');
    expect(second.body.results[0].status).toBe('COMMITTED');
    expect(first.body.results[0].entityId).toBe(customerId);
    expect(second.body.results[0].entityId).toBe(customerId);

    const storedCustomers = await db.db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, customerId));
    expect(storedCustomers).toHaveLength(1);
  });

  it('keeps idempotency keys scoped to the business', async () => {
    const businessA = await registerBusiness(app, 'Sync Tenant A');
    const businessB = await registerBusiness(app, 'Sync Tenant B');
    const deviceA = 'sync-tenant-a-device';
    const deviceB = 'sync-tenant-b-device';

    await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/sync/devices/register')
        .set('Authorization', `Bearer ${businessA.accessToken}`)
        .send({ deviceId: deviceA, deviceType: 'DESKTOP' })
        .expect(200),
      request(app.getHttpServer())
        .post('/api/v1/sync/devices/register')
        .set('Authorization', `Bearer ${businessB.accessToken}`)
        .send({ deviceId: deviceB, deviceType: 'DESKTOP' })
        .expect(200),
    ]);

    const sharedOperationId = 'same-id-across-two-businesses';
    const push = (token: string, deviceId: string, customerName: string) =>
      request(app.getHttpServer())
        .post('/api/v1/sync/push')
        .set('Authorization', `Bearer ${token}`)
        .send({
          deviceId,
          operations: [{
            clientOperationId: sharedOperationId,
            operationType: 'CREATE_CUSTOMER',
            clientTimestamp: new Date().toISOString(),
            payload: { name: customerName },
          }],
        })
        .expect(200);

    const [resultA, resultB] = await Promise.all([
      push(businessA.accessToken, deviceA, 'Tenant A customer'),
      push(businessB.accessToken, deviceB, 'Tenant B customer'),
    ]);
    expect(resultA.body.results[0].status).toBe('COMMITTED');
    expect(resultB.body.results[0].status).toBe('COMMITTED');
    expect(resultA.body.results[0].entityId).not.toBe(resultB.body.results[0].entityId);
  });
});
