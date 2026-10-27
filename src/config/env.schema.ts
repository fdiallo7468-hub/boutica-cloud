import { z } from 'zod';

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required (e.g. a Neon connection string — see .env.example)')
      .default('postgresql://user:password@localhost:5432/boutica'),
    BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be a random string of at least 32 characters').default('boutica_cloud_default_dev_secret_at_least_32_characters_random'),
    BETTER_AUTH_URL: z.string().url('BETTER_AUTH_URL must be a full URL, e.g. http://localhost:3000').default('http://localhost:3000'),
    CORS_ORIGIN: z.string().optional(),

    // Phase 2: Arcjet Security
    ARCJET_KEY: z.string().optional(),
    ARCJET_ENV: z.enum(['development', 'production', 'test']).optional(),

    // Stockage Médias local zéro-coût (remplace Cloudflare R2)
    UPLOADS_DIR: z.string().optional().default("./uploads"),

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
    EMAIL_FROM: z.string().default("Boutica Cloud <notifications@boutica.cloud>"),
    RESET_PASSWORD_URL: z.string().url().optional(),

    // Puppeteer & PDF Generation
    PUPPETEER_CACHE_DIR: z.string().optional(),
    PUPPETEER_EXECUTABLE_PATH: z.string().optional(),
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
