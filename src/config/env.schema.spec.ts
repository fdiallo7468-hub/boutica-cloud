import { envSchema, KNOWN_DEV_SECRETS } from './env.schema';

describe('envSchema Validation', () => {
  const validProductionEnv = {
    NODE_ENV: 'production',
    PORT: '3000',
    DATABASE_URL: 'postgresql://neondb_owner:prod_secret_pass@ep-cool-wildflower.neon.tech/neondb?sslmode=require',
    BETTER_AUTH_SECRET: 'production_super_secure_random_key_with_high_entropy_12345!',
    BETTER_AUTH_URL: 'https://boutica-cloud.onrender.com',
    CORS_ORIGIN: 'https://boutica-cloud.onrender.com,https://app.boutica.cloud',
  };

  describe('Environnement de Développement / Test', () => {
    it('devrait appliquer des valeurs de repli sûres en développement si aucune variable n est fournie', () => {
      const parsed = envSchema.parse({ NODE_ENV: 'development' });
      expect(parsed.DATABASE_URL).toContain('postgresql://');
      expect(parsed.BETTER_AUTH_SECRET).toBeDefined();
      expect(parsed.BETTER_AUTH_SECRET.length).toBeGreaterThanOrEqual(32);
      expect(parsed.BETTER_AUTH_URL).toBe('http://localhost:3000');
      expect(parsed.CORS_ORIGIN).toBe('http://localhost:3000,http://localhost:5173');
      expect(parsed.UPLOADS_DIR).toBe('./uploads');
    });

    it('devrait accepter des valeurs personnalisées en développement', () => {
      const parsed = envSchema.parse({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://custom:5432/test',
        BETTER_AUTH_SECRET: 'my_custom_secret_for_local_development_testing_123',
        BETTER_AUTH_URL: 'http://localhost:8080',
      });
      expect(parsed.DATABASE_URL).toBe('postgresql://custom:5432/test');
      expect(parsed.BETTER_AUTH_SECRET).toBe('my_custom_secret_for_local_development_testing_123');
      expect(parsed.BETTER_AUTH_URL).toBe('http://localhost:8080');
    });
  });

  describe('Environnement de Production Valide', () => {
    it('devrait valider avec succès une configuration de production complète et sécurisée', () => {
      const parsed = envSchema.parse(validProductionEnv);
      expect(parsed.NODE_ENV).toBe('production');
      expect(parsed.DATABASE_URL).toBe(validProductionEnv.DATABASE_URL);
      expect(parsed.BETTER_AUTH_SECRET).toBe(validProductionEnv.BETTER_AUTH_SECRET);
      expect(parsed.BETTER_AUTH_URL).toBe(validProductionEnv.BETTER_AUTH_URL);
      expect(parsed.CORS_ORIGIN).toBe(validProductionEnv.CORS_ORIGIN);
    });
  });

  describe('Rejet des Configurations de Production Dangereuses ou Incomplètes', () => {
    it('devrait rejeter une configuration de production sans DATABASE_URL', () => {
      const { DATABASE_URL, ...incomplete } = validProductionEnv;
      const result = envSchema.safeParse(incomplete);
      expect(result.success).toBe(false);
      if (!result.success) {
        const dbIssue = result.error.issues.find((i) => i.path.includes('DATABASE_URL'));
        expect(dbIssue).toBeDefined();
        expect(dbIssue?.message).toContain('DATABASE_URL is required in production');
      }
    });

    it('devrait rejeter une DATABASE_URL pointant vers localhost en production', () => {
      const dangerous = {
        ...validProductionEnv,
        DATABASE_URL: 'postgresql://user:password@localhost:5432/boutica',
      };
      const result = envSchema.safeParse(dangerous);
      expect(result.success).toBe(false);
      if (!result.success) {
        const dbIssue = result.error.issues.find((i) => i.path.includes('DATABASE_URL'));
        expect(dbIssue?.message).toContain('localhost or demo fallback');
      }
    });

    it('devrait rejeter un protocole de base de données invalide', () => {
      const invalid = {
        ...validProductionEnv,
        DATABASE_URL: 'mysql://remote.host:3306/boutica',
      };
      const result = envSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        const dbIssue = result.error.issues.find((i) => i.path.includes('DATABASE_URL'));
        expect(dbIssue?.message).toContain('starting with postgresql:// or postgres://');
      }
    });

    it('devrait rejeter les secrets de développement connus en production', () => {
      for (const knownSecret of KNOWN_DEV_SECRETS) {
        const dangerous = {
          ...validProductionEnv,
          BETTER_AUTH_SECRET: knownSecret,
        };
        const result = envSchema.safeParse(dangerous);
        expect(result.success).toBe(false);
        if (!result.success) {
          const secretIssue = result.error.issues.find((i) => i.path.includes('BETTER_AUTH_SECRET'));
          expect(secretIssue?.message).toContain('cannot use a known development default or demo secret');
        }
      }
    });

    it('devrait rejeter un secret de moins de 32 caractères en production', () => {
      const dangerous = {
        ...validProductionEnv,
        BETTER_AUTH_SECRET: 'short_secret_key_12345',
      };
      const result = envSchema.safeParse(dangerous);
      expect(result.success).toBe(false);
      if (!result.success) {
        const secretIssue = result.error.issues.find((i) => i.path.includes('BETTER_AUTH_SECRET'));
        expect(secretIssue?.message).toContain('at least 32 characters');
      }
    });

    it('devrait rejeter un secret répétitif ou de faible entropie', () => {
      const weak = {
        ...validProductionEnv,
        BETTER_AUTH_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      };
      const result = envSchema.safeParse(weak);
      expect(result.success).toBe(false);
      if (!result.success) {
        const secretIssue = result.error.issues.find((i) => i.path.includes('BETTER_AUTH_SECRET'));
        expect(secretIssue?.message).toContain('too repetitive or weak');
      }
    });

    it('devrait rejeter BETTER_AUTH_URL pointant vers localhost en production', () => {
      const dangerous = {
        ...validProductionEnv,
        BETTER_AUTH_URL: 'http://localhost:3000',
      };
      const result = envSchema.safeParse(dangerous);
      expect(result.success).toBe(false);
      if (!result.success) {
        const urlIssue = result.error.issues.find((i) => i.path.includes('BETTER_AUTH_URL'));
        expect(urlIssue?.message).toContain('cannot point to localhost or 127.0.0.1 in production');
      }
    });

    it('devrait rejeter une configuration de production sans CORS_ORIGIN', () => {
      const { CORS_ORIGIN, ...incomplete } = validProductionEnv;
      const result = envSchema.safeParse(incomplete);
      expect(result.success).toBe(false);
      if (!result.success) {
        const corsIssue = result.error.issues.find((i) => i.path.includes('CORS_ORIGIN'));
        expect(corsIssue?.message).toContain('CORS_ORIGIN must be set explicitly in production');
      }
    });

    it('ne devrait jamais faire fuiter de valeur de secret dans les messages d erreur', () => {
      const secretToHide = 'top_secret_sensitive_password_attempt_32_chars';
      const dangerous = {
        ...validProductionEnv,
        BETTER_AUTH_SECRET: secretToHide,
        DATABASE_URL: 'invalid-url',
      };
      const result = envSchema.safeParse(dangerous);
      expect(result.success).toBe(false);
      if (!result.success) {
        const serialized = JSON.stringify(result.error.issues);
        expect(serialized).not.toContain(secretToHide);
      }
    });
  });

  describe('Méthode validate pour ConfigModule de NestJS', () => {
    it('devrait renvoyer { value } lorsque la configuration est valide', () => {
      const res = (envSchema as any).validate({ NODE_ENV: 'test' });
      expect(res.value).toBeDefined();
      expect(res.error).toBeUndefined();
    });

    it('devrait renvoyer { error } lorsque la configuration de production est invalide', () => {
      const res = (envSchema as any).validate({ NODE_ENV: 'production' });
      expect(res.error).toBeDefined();
      expect(res.value).toBeUndefined();
    });
  });
});
