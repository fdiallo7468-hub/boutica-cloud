import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const migrationDatabaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  process.env.DATABASE_URL_UNPOOLED ??
  (process.env.NODE_ENV === 'production' ? undefined : process.env.DATABASE_URL);

if (!migrationDatabaseUrl) {
  throw new Error(
    'DATABASE_MIGRATION_URL is required for production migrations; use a direct PostgreSQL connection owned by this deployment',
  );
}

const parsedMigrationUrl = new URL(migrationDatabaseUrl);
if (!['postgres:', 'postgresql:'].includes(parsedMigrationUrl.protocol)) {
  throw new Error('DATABASE_MIGRATION_URL must be a PostgreSQL connection string');
}

export default defineConfig({
  schema: './src/infrastructure/database/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: migrationDatabaseUrl },
});
