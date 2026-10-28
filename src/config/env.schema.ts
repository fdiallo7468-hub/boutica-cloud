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
 * Détermine si un nom d'hôte ou une adresse IP correspond à une zone locale,
 * privée (RFC 1918, RFC 3927), de test ou dangereuse pour une exposition publique.
 */
export function isPrivateOrDangerousHost(hostname: string): boolean {
  if (!hostname || typeof hostname !== 'string') {
    return true;
  }

  const host = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '');

  // 1. Loopback et adresses non routables
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1'
  ) {
    return true;
  }

  // 2. Domaines réservés et réseaux locaux (RFC 6761, RFC 2606)
  if (
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home.arpa') ||
    host.endsWith('.test') ||
    host.endsWith('.example') ||
    host.endsWith('.invalid')
  ) {
    return true;
  }

  // 3. Adresses IPv4 (décimales)
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = host.match(ipv4Regex);
  if (match) {
    const oct1 = Number(match[1]);
    const oct2 = Number(match[2]);
    const oct3 = Number(match[3]);
    const oct4 = Number(match[4]);

    if (oct1 > 255 || oct2 > 255 || oct3 > 255 || oct4 > 255) {
      return true; // IPv4 invalide/hors limites
    }

    // 0.0.0.0/8
    if (oct1 === 0) return true;

    // 127.0.0.0/8 (Loopback)
    if (oct1 === 127) return true;

    // 10.0.0.0/8 (RFC 1918)
    if (oct1 === 10) return true;

    // 172.16.0.0/12 (RFC 1918: 172.16.x.x - 172.31.x.x)
    if (oct1 === 172 && oct2 >= 16 && oct2 <= 31) return true;

    // 192.168.0.0/16 (RFC 1918)
    if (oct1 === 192 && oct2 === 168) return true;

    // 169.254.0.0/16 (Link-local RFC 3927 / Cloud Metadata)
    if (oct1 === 169 && oct2 === 254) return true;

    // 100.64.0.0/10 (Carrier Grade NAT RFC 6598)
    if (oct1 === 100 && oct2 >= 64 && oct2 <= 127) return true;
  }

  // 4. Adresses IPv6 privées / Link-Local / ULA
  if (
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe8') ||
    host.startsWith('fe9') ||
    host.startsWith('fea') ||
    host.startsWith('feb')
  ) {
    return true;
  }

  return false;
}

/**
 * Valide qu'une chaîne représente une origine CORS valide (scheme://host[:port]),
 * sans chemin d'accès, paramètre de requête ni fragment.
 */
export function isValidCorsOrigin(origin: string, isProduction: boolean): { valid: boolean; reason?: string } {
  if (!origin || typeof origin !== 'string') {
    return { valid: false, reason: 'Origine vide ou non textuelle' };
  }

  const trimmed = origin.trim();

  // Rejet absolu du wildcard '*' (incompatible avec credentials: true et dangereux)
  if (trimmed === '*') {
    return { valid: false, reason: 'Le caractère wildcard "*" est interdit car les requêtes authentifiées avec cookies/credentials sont activées' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: `URL malformée: ${trimmed}` };
  }

  // Vérification de la structure stricte d'origine (scheme://hostname[:port])
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return { valid: false, reason: `Une origine CORS ne doit pas comporter de chemin d'accès (${parsed.pathname})` };
  }
  if (parsed.search || parsed.hash) {
    return { valid: false, reason: `Une origine CORS ne doit comporter ni query parameters ni fragment` };
  }

  if (isProduction) {
    if (parsed.protocol !== 'https:') {
      return { valid: false, reason: `En production, chaque origine CORS doit impérativement utiliser le protocole HTTPS (${trimmed})` };
    }
    if (isPrivateOrDangerousHost(parsed.hostname)) {
      return { valid: false, reason: `En production, une origine CORS ne peut pas cibler un hôte privé ou local (${parsed.hostname})` };
    }
  } else {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, reason: `Protocole d'origine non supporté (${parsed.protocol})` };
    }
  }

  return { valid: true };
}

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

export const envSchema = rawEnvSchema.transform((raw, ctx) => {
  const isProduction = raw.NODE_ENV === 'production';

  // 1. Validation de DATABASE_URL
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
    if (!databaseUrl || databaseUrl.trim() === '') {
      databaseUrl = 'postgresql://user:password@localhost:5432/boutica';
    }
  }

  // 2. Validation de BETTER_AUTH_SECRET
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

  // 3. Validation de BETTER_AUTH_URL (Exigence stricte HTTPS et interdiction des hôtes privés en prod)
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
        if (parsedUrl.protocol !== 'https:') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['BETTER_AUTH_URL'],
            message: 'BETTER_AUTH_URL must strictly use HTTPS in production (e.g. https://boutica-cloud.onrender.com)',
          });
        }
        if (isPrivateOrDangerousHost(parsedUrl.hostname)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['BETTER_AUTH_URL'],
            message: `BETTER_AUTH_URL cannot use a private, loopback, or local network address in production (${parsedUrl.hostname})`,
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

  // 4. Validation de CORS_ORIGIN
  let corsOrigin = raw.CORS_ORIGIN;
  if (isProduction) {
    if (!corsOrigin || corsOrigin.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGIN'],
        message: 'CORS_ORIGIN must be set explicitly in production (comma-separated authorized origins)',
      });
    } else {
      const origins = corsOrigin.split(',').map((o) => o.trim()).filter(Boolean);
      if (origins.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGIN'],
          message: 'CORS_ORIGIN must contain at least one valid origin',
        });
      }
      for (const origin of origins) {
        const check = isValidCorsOrigin(origin, true);
        if (!check.valid) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['CORS_ORIGIN'],
            message: `Invalid CORS origin "${origin}": ${check.reason}`,
          });
        }
      }
    }
  } else {
    if (!corsOrigin || corsOrigin.trim() === '') {
      corsOrigin = 'http://localhost:3000,http://localhost:5173';
    } else {
      const origins = corsOrigin.split(',').map((o) => o.trim()).filter(Boolean);
      for (const origin of origins) {
        const check = isValidCorsOrigin(origin, false);
        if (!check.valid) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['CORS_ORIGIN'],
            message: `Invalid CORS origin "${origin}": ${check.reason}`,
          });
        }
      }
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
