import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { createProductWithVariant, createTestApp, registerBusiness, resetDatabase, adjustStock } from '../utils/test-app';
import { DatabaseService } from '../../src/infrastructure/database/database';
import { products, saleItems } from '../../src/infrastructure/database/schema';

describe('PostgreSQL tenant RLS (e2e)', () => {
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

  async function asRuntime<T>(businessId: string | null, work: (tx: any) => Promise<T>): Promise<T> {
    return db.baseDb.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE boutica_runtime`);
      if (businessId) {
        await tx.execute(sql`SELECT set_config('app.business_id', ${businessId}, true)`);
      }
      return work(tx);
    });
  }

  it('fails closed without tenant context and returns only the active business rows', async () => {
    const a = await registerBusiness(app, 'RLS Shop A');
    const b = await registerBusiness(app, 'RLS Shop B');
    const aProduct = await createProductWithVariant(app, a.accessToken);
    const bProduct = await createProductWithVariant(app, b.accessToken);

    const withoutContext = await asRuntime(null, (tx) =>
      tx.select({ id: products.id }).from(products),
    );
    expect(withoutContext).toHaveLength(0);

    const aRows = await asRuntime(a.businessId, (tx) =>
      tx.select({ id: products.id }).from(products),
    );
    expect(aRows.map((row: { id: string }) => row.id)).toEqual([aProduct.productId]);
    expect(aRows.some((row: { id: string }) => row.id === bProduct.productId)).toBe(false);
  });

  it('rejects forged business_id inserts and hides cross-tenant UPDATE/DELETE targets', async () => {
    const a = await registerBusiness(app, 'RLS Write A');
    const b = await registerBusiness(app, 'RLS Write B');
    const bProduct = await createProductWithVariant(app, b.accessToken);

    await expect(asRuntime(a.businessId, async (tx) => {
      await tx.insert(products).values({
        businessId: b.businessId,
        name: 'Forged cross-tenant product',
      });
    })).rejects.toThrow(/row-level security|policy/i);

    const updated = await asRuntime(a.businessId, (tx) =>
      tx.update(products)
        .set({ name: 'Cross-tenant mutation' })
        .where(eq(products.id, bProduct.productId))
        .returning({ id: products.id }),
    );
    expect(updated).toHaveLength(0);

    const deleted = await asRuntime(a.businessId, (tx) =>
      tx.delete(products)
        .where(eq(products.id, bProduct.productId))
        .returning({ id: products.id }),
    );
    expect(deleted).toHaveLength(0);
  });

  it('rejects a child row that links a tenant A sale to a tenant B variant', async () => {
    const a = await registerBusiness(app, 'RLS Child A');
    const b = await registerBusiness(app, 'RLS Child B');
    const aProduct = await createProductWithVariant(app, a.accessToken, { sellingPrice: 10, purchasePrice: 5 });
    const bProduct = await createProductWithVariant(app, b.accessToken, { sellingPrice: 10, purchasePrice: 5 });

    await adjustStock(app, a.accessToken, aProduct.variantId, 5);
    const sale = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ items: [{ variantId: aProduct.variantId, quantity: 1 }] })
      .expect(201);

    await expect(asRuntime(a.businessId, async (tx) => {
      await tx.insert(saleItems).values({
        saleId: sale.body.id,
        variantId: bProduct.variantId,
        quantity: 1,
        unitPrice: '10',
        costAtSale: '5',
      });
    })).rejects.toThrow(/row-level security|policy/i);
  });
});
