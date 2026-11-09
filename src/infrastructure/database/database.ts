import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

/**
 * ROUND 2 FIX: this file used to read `process.env.DATABASE_URL` directly,
 * unvalidated, in a dense one-line style that was out of step with the rest
 * of the codebase (it looks like it was missed by the round-1 pass — every
 * other infrastructure file was reformatted and had its env access moved
 * behind validation). `DATABASE_URL` is now guaranteed present and
 * non-empty by `envSchema` (see src/config/env.schema.ts), validated once
 * at bootstrap instead of failing lazily on the first query.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  readonly pool: Pool;
  readonly db: NodePgDatabase<typeof schema>;

  constructor(config: ConfigService) {
    this.pool = new Pool({
      connectionString: config.get<string>('DATABASE_URL'),
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    this.db = drizzle(this.pool, { schema });
  }

  async onModuleInit(): Promise<void> {
    if (this.configIsProduction()) {
      const result = await this.db.execute(sql`
        SELECT count(*)::int AS trigger_count
        FROM pg_trigger
        WHERE tgrelid = 'users'::regclass
          AND tgname IN (
            'users_provision_business_before_insert',
            'users_attach_business_membership_after_insert'
          )
          AND NOT tgisinternal
      `);
      const triggerCount = Number(result.rows[0]?.trigger_count ?? 0);
      if (triggerCount !== 2) {
        throw new Error(
          'Required atomic user/business provisioning triggers are missing. Apply Drizzle migration 0010 before starting the production API.',
        );
      }
    }
  }

  private configIsProduction(): boolean {
    return this.pool.options.connectionString !== undefined &&
      process.env.NODE_ENV === 'production';
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
