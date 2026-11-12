import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createProductWithVariant, createTestApp, registerBusiness, resetDatabase, adjustStock } from '../utils/test-app';
import { DatabaseService } from '../../src/infrastructure/database/database';
import { businessMembers, businesses, products, saleItems, users } from '../../src/infrastructure/database/schema';

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


  it('fails closed without tenant context and returns only the active business rows', async () => {
    const a = await registerBusiness(app, 'RLS Shop A');
    const b = await registerBusiness(app, 'RLS Shop B');
    const aProduct = await createProductWithVariant(app, a.accessToken);
    const bProduct = await createProductWithVariant(app, b.accessToken);

    const withoutContext = await db.baseDb.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE boutica_runtime`);
      return tx.select({ id: products.id }).from(products);
    });
    expect(withoutContext).toHaveLength(0);

    const aRows = await db.baseDb.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE boutica_runtime`);
      await tx.execute(sql`SELECT set_config('app.business_id', ${a.businessId}, true)`);
      return tx.select({ id: products.id }).from(products);
    });
    expect(aRows.map((row: { id: string }) => row.id)).toEqual([aProduct.productId]);
    expect(aRows.some((row: { id: string }) => row.id === bProduct.productId)).toBe(false);
  });

  it('rejects forged business_id inserts and hides cross-tenant UPDATE/DELETE targets', async () => {
    const a = await registerBusiness(app, 'RLS Write A');
    const b = await registerBusiness(app, 'RLS Write B');
    const bProduct = await createProductWithVariant(app, b.accessToken);

    await expect(db.baseDb.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE boutica_runtime`);
      await tx.execute(sql`SELECT set_config('app.business_id', ${a.businessId}, true)`);
      await tx.insert(products).values({
        businessId: b.businessId,
        name: 'Forged cross-tenant product',
      });
    })).rejects.toThrow(/row-level security|policy/i);

    const updated = await db.baseDb.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE boutica_runtime`);
      await tx.execute(sql`SELECT set_config('app.business_id', ${a.businessId}, true)`);
      return tx.update(products)
        .set({ name: 'Cross-tenant mutation' })
        .where(eq(products.id, bProduct.productId))
        .returning({ id: products.id });
    });
    expect(updated).toHaveLength(0);

    const deleted = await db.baseDb.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE boutica_runtime`);
      await tx.execute(sql`SELECT set_config('app.business_id', ${a.businessId}, true)`);
      return tx.delete(products)
        .where(eq(products.id, bProduct.productId))
        .returning({ id: products.id });
    });
    expect(deleted).toHaveLength(0);
  });

  it('limits membership discovery to the actor and supports scoped business bootstrap', async () => {
    const a = await registerBusiness(app, 'RLS Membership A');
    const b = await registerBusiness(app, 'RLS Membership B');
    const [owner] = await db.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.businessId, a.businessId))
      .limit(1);
    expect(owner).toBeDefined();

    const visibleMemberships = await db.baseDb.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE boutica_runtime`);
      await tx.execute(sql`SELECT set_config('app.actor_user_id', ${owner!.id}, true)`);
      return tx.select({ businessId: businessMembers.businessId })
        .from(businessMembers);
    });
    expect(visibleMemberships.map((row) => row.businessId)).toEqual([a.businessId]);
    expect(visibleMemberships.some((row) => row.businessId === b.businessId)).toBe(false);

    const newBusinessId = randomUUID();
    const created = await db.baseDb.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE boutica_runtime`);
      await tx.execute(sql`
        SELECT
          set_config('app.actor_user_id', ${owner!.id}, true),
          set_config('app.business_id', ${newBusinessId}, true)
      `);
      const [business] = await tx.insert(businesses).values({
        id: newBusinessId,
        name: 'RLS-created additional business',
        currency: 'XOF',
        sector: 'QUINCAILLERIE',
      }).returning();
      await tx.insert(businessMembers).values({
        businessId: newBusinessId,
        userId: owner!.id,
        role: 'OWNER',
      });
      return business;
    });
    if (!created) {
      throw new Error('Expected tenant business bootstrap to return the inserted business');
    }
    expect(created.id).toBe(newBusinessId);

    await expect(db.baseDb.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE boutica_runtime`);
      await tx.execute(sql`
        SELECT
          set_config('app.actor_user_id', ${owner!.id}, true),
          set_config('app.business_id', ${a.businessId}, true)
      `);
      await tx.insert(businessMembers).values({
        businessId: b.businessId,
        userId: owner!.id,
        role: 'OWNER',
      });
    })).rejects.toThrow(/row-level security|policy/i);
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

    await expect(db.baseDb.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE boutica_runtime`);
      await tx.execute(sql`SELECT set_config('app.business_id', ${a.businessId}, true)`);
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
