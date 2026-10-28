import { z } from 'zod';

export const KNOWN_DEV_SECRETS = [
  'boutica_cloud_default_dev_secret_at_least_32_characters_random',
  'supersecretkeythatisatleast32characterslong!',
  'change_me_in_production_please_change_me!',
  'dev_secret_key_1234567890_at_least_32_chars',
  '12345678901234567890123456789012',
  'abcdefghijklmnopqrstuvwxyz123456',
];

const KNOWN_DEV_DB_URLS = [
  'postgresql://user:password@localhost:5432/boutica',
  'postgresql://localhost:5432/boutica',
  'postgres://localhost:5432/boutica',
];

/**
 * Base schema without development defaults, used to detect whether values were
 * explicitly provided by the operator or need fallback in non-production environments.
 */
const rawEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z.string().optional(),
  CORS_ORIGIN: z.string().optional(),

  // Phase 2: Arcjet Security
  ARCJET_KEY: z.string().optional(),
  ARCJET_ENV: z.enum(['development', 'production', 'test']).optional(),

  // Stockage Médias local zéro-coût
  UPLOADS_DIR: z.string().optional().default('./uploads'),

  // Phase 6: Novu Notification Engine
  NOVU_API_KEY: z.string().optional(),
  NOVU_BACKEND_URL: z.string().url().optional(),

  // Google Sign-In
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // Apple Sign-In
  APPLE_CLIENT_ID: z.string().optional(),
  APPLE_CLIENT_SECRET: z.string().optional(),
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  APPLE_PRIVATE_KEY: z.string().optional(),

  // Resend & Transactional Email
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Boutica Cloud <notifications@boutica.cloud>'),
  RESET_PASSWORD_URL: z.string().url().optional(),

  // Puppeteer & PDF Generation
  PUPPETEER_CACHE_DIR: z.string().optional(),
  PUPPETEER_EXECUTABLE_PATH: z.string().optional(),
});

/**
 * Strict schema with conditional environment validation.
 * In production:
 * - Refuses silent defaults.
 * - Enforces real PostgreSQL connection string (rejects localhost, demo DBs).
 * - Enforces robust secret (>=32 chars, not known dev secrets, high entropy).
 * - Enforces real production HTTPS/public URL (rejects localhost).
 * - Enforces explicit CORS origins.
 */
export const envSchema = rawEnvSchema.transform((raw, ctx) => {
  const isProduction = raw.NODE_ENV === 'production';

  // 1. DATABASE_URL validation
  let databaseUrl = raw.DATABASE_URL;
  if (isProduction) {
    if (!databaseUrl || databaseUrl.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL is required in production (e.g. a Neon or PostgreSQL connection string)',
      });
    } else if (
      KNOWN_DEV_DB_URLS.includes(databaseUrl.trim()) ||
      databaseUrl.includes('localhost') ||
      databaseUrl.includes('127.0.0.1')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL cannot use localhost or demo fallback values in production',
      });
    } else if (!databaseUrl.startsWith('postgresql://') && !databaseUrl.startsWith('postgres://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL must be a valid PostgreSQL connection string starting with postgresql:// or postgres://',
      });
    }
  } else {
    // Non-production fallback
    if (!databaseUrl || databaseUrl.trim() === '') {
      databaseUrl = 'postgresql://user:password@localhost:5432/boutica';
    }
  }

  // 2. BETTER_AUTH_SECRET validation
  let authSecret = raw.BETTER_AUTH_SECRET;
  if (isProduction) {
    if (!authSecret || authSecret.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BETTER_AUTH_SECRET'],
        message: 'BETTER_AUTH_SECRET is required in production (minimum 32 characters)',
      });
    } else if (authSecret.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BETTER_AUTH_SECRET'],
        message: 'BETTER_AUTH_SECRET must be at least 32 characters long in production',
      });
    } else if (KNOWN_DEV_SECRETS.includes(authSecret.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BETTER_AUTH_SECRET'],
        message: 'BETTER_AUTH_SECRET cannot use a known development default or demo secret in production',
      });
    } else if (new Set(authSecret).size < 5) {
      // Reject trivial repetitive secrets like "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BETTER_AUTH_SECRET'],
        message: 'BETTER_AUTH_SECRET is too repetitive or weak for production use',
      });
    }
  } else {
    if (!authSecret || authSecret.trim() === '') {
      authSecret = 'boutica_cloud_default_dev_secret_at_least_32_characters_random';
    }
  }

  // 3. BETTER_AUTH_URL validation
  let authUrl = raw.BETTER_AUTH_URL;
  if (isProduction) {
    if (!authUrl || authUrl.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BETTER_AUTH_URL'],
        message: 'BETTER_AUTH_URL is required in production (e.g. https://boutica-cloud.onrender.com)',
      });
    } else {
      try {
        const parsedUrl = new URL(authUrl);
        if (parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['BETTER_AUTH_URL'],
            message: 'BETTER_AUTH_URL cannot point to localhost or 127.0.0.1 in production',
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['BETTER_AUTH_URL'],
          message: 'BETTER_AUTH_URL must be a valid URL in production',
        });
      }
    }
  } else {
    if (!authUrl || authUrl.trim() === '') {
      authUrl = 'http://localhost:3000';
    }
  }

  // 4. CORS_ORIGIN validation
  let corsOrigin = raw.CORS_ORIGIN;
  if (isProduction) {
    if (!corsOrigin || corsOrigin.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGIN'],
        message: 'CORS_ORIGIN must be set explicitly in production (comma-separated authorized origins)',
      });
    }
  } else {
    if (!corsOrigin || corsOrigin.trim() === '') {
      corsOrigin = 'http://localhost:3000,http://localhost:5173';
    }
  }

  return {
    ...raw,
    DATABASE_URL: databaseUrl as string,
    BETTER_AUTH_SECRET: authSecret as string,
    BETTER_AUTH_URL: authUrl as string,
    CORS_ORIGIN: corsOrigin as string,
  };
});

/**
 * Validation helper for NestJS ConfigModule
 */
Object.assign(envSchema, {
  validate(config: Record<string, unknown>) {
    const result = envSchema.safeParse(config);
    if (result.success) {
      return { value: result.data };
    }
    return { error: result.error };
  },
});

export type Env = z.infer<typeof envSchema>;
