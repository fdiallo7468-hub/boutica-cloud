import { z } from 'zod';

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required (e.g. a Neon connection string — see .env.example)'),
    BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be a random string of at least 32 characters'),
    BETTER_AUTH_URL: z.string().url('BETTER_AUTH_URL must be a full URL, e.g. http://localhost:3000'),
    CORS_ORIGIN: z.string().optional(),

    // Phase 2: Arcjet Security
    ARCJET_KEY: z.string().optional(),
    ARCJET_ENV: z.enum(['development', 'production', 'test']).optional(),

    // Phase 3: Cloudflare R2 Storage (S3-compatible)
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET_NAME: z.string().optional(),
    R2_PUBLIC_URL: z.string().url().optional(),

    // Phase 5: Redis & BullMQ Asynchronous Queues
    REDIS_URL: z.string().optional(),
    REDIS_HOST: z.string().optional(),
    REDIS_PORT: z.coerce.number().int().positive().optional(),
    REDIS_PASSWORD: z.string().optional(),

    // Phase 6: Novu Notification Engine
    NOVU_API_KEY: z.string().optional(),
    NOVU_BACKEND_URL: z.string().url().optional(),
  })
  .refine((env) => env.NODE_ENV !== 'production' || !!env.CORS_ORIGIN, {
    message: 'CORS_ORIGIN must be set explicitly when NODE_ENV=production (comma-separated origins)',
    path: ['CORS_ORIGIN'],
  });

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
