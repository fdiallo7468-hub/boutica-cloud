import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { TenantDatabaseContext } from './tenant-database-context';

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
  readonly baseDb: NodePgDatabase<typeof schema>;

  /** Uses the request-local transaction when a verified tenant context exists. */
  get db(): NodePgDatabase<typeof schema> {
    return (this.tenantDatabaseContext.current as NodePgDatabase<typeof schema> | undefined) ?? this.baseDb;
  }

  constructor(
    private readonly config: ConfigService,
    private readonly tenantDatabaseContext: TenantDatabaseContext,
  ) {
    this.pool = new Pool({
      connectionString: this.config.get<string>('DATABASE_URL'),
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    this.baseDb = drizzle(this.pool, { schema });
  }

  async onModuleInit(): Promise<void> {
    if (this.configIsProduction()) {
      const result = await this.baseDb.execute(sql`
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
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
