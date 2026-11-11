import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const migrationDatabaseUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!migrationDatabaseUrl) {
  throw new Error('DATABASE_URL_UNPOOLED (preferred) or DATABASE_URL is required for Drizzle migrations');
}

const migrationHost = new URL(migrationDatabaseUrl).hostname;
if (migrationHost.includes('-pooler')) {
  throw new Error('Drizzle migrations require a direct, unpooled PostgreSQL connection; configure DATABASE_URL_UNPOOLED');
}

export default defineConfig({
  schema: './src/infrastructure/database/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: migrationDatabaseUrl },
});
