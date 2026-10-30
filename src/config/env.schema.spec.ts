import { envSchema, isPrivateOrDangerousHost, isValidCorsOrigin, KNOWN_DEV_SECRETS } from './env.schema';

describe('envSchema Validation & Security', () => {
  const validProductionEnv = {
    NODE_ENV: 'production',
    PORT: '3000',
    DATABASE_URL: 'postgresql://neondb_owner:prod_secret_pass@ep-cool-wildflower.neon.tech/neondb?sslmode=require',
    BETTER_AUTH_SECRET: 'production_super_secure_random_key_with_high_entropy_12345!',
    BETTER_AUTH_URL: 'https://boutica-cloud.onrender.com',
    CORS_ORIGIN: 'https://boutica-cloud.onrender.com,https://app.boutica.cloud',
  };

  describe('isPrivateOrDangerousHost Helper', () => {
    it('devrait détecter localhost et les adresses de boucle locale', () => {
      expect(isPrivateOrDangerousHost('localhost')).toBe(true);
      expect(isPrivateOrDangerousHost('api.localhost')).toBe(true);
      expect(isPrivateOrDangerousHost('127.0.0.1')).toBe(true);
      expect(isPrivateOrDangerousHost('127.0.1.1')).toBe(true);
      expect(isPrivateOrDangerousHost('0.0.0.0')).toBe(true);
      expect(isPrivateOrDangerousHost('::1')).toBe(true);
    });

    it('devrait détecter les adresses privées RFC 1918 et link-local RFC 3927', () => {
      expect(isPrivateOrDangerousHost('10.0.0.1')).toBe(true);
      expect(isPrivateOrDangerousHost('10.255.255.254')).toBe(true);
      expect(isPrivateOrDangerousHost('172.16.0.1')).toBe(true);
      expect(isPrivateOrDangerousHost('172.31.255.255')).toBe(true);
      expect(isPrivateOrDangerousHost('192.168.1.1')).toBe(true);
      expect(isPrivateOrDangerousHost('192.168.0.254')).toBe(true);
      expect(isPrivateOrDangerousHost('169.254.169.254')).toBe(true); // AWS/GCP metadata
    });

    it('devrait détecter les domaines de test et réservés', () => {
      expect(isPrivateOrDangerousHost('server.local')).toBe(true);
      expect(isPrivateOrDangerousHost('corp.internal')).toBe(true);
      expect(isPrivateOrDangerousHost('test.example')).toBe(true);
    });

    it('devrait autoriser les domaines publics légitimes', () => {
      expect(isPrivateOrDangerousHost('boutica.cloud')).toBe(false);
      expect(isPrivateOrDangerousHost('api.boutica.cloud')).toBe(false);
      expect(isPrivateOrDangerousHost('boutica-cloud.onrender.com')).toBe(false);
      expect(isPrivateOrDangerousHost('neon.tech')).toBe(false);
    });
  });

  describe('isValidCorsOrigin Helper', () => {
    it('devrait rejeter le wildcard * lorsque credentials: true est actif', () => {
      const res = isValidCorsOrigin('*', true);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('wildcard "*" est interdit');
    });

    it('devrait rejeter les origines avec chemin ou query parameters', () => {
      expect(isValidCorsOrigin('https://boutica.cloud/api', true).valid).toBe(false);
      expect(isValidCorsOrigin('https://boutica.cloud?query=1', true).valid).toBe(false);
      expect(isValidCorsOrigin('https://boutica.cloud#anchor', true).valid).toBe(false);
    });

    it('devrait exiger HTTPS en production et rejeter les origines HTTP non sécurisées', () => {
      expect(isValidCorsOrigin('http://boutica.cloud', true).valid).toBe(false);
      expect(isValidCorsOrigin('https://boutica.cloud', true).valid).toBe(true);
    });

    it('devrait accepter http://localhost en développement', () => {
      expect(isValidCorsOrigin('http://localhost:5173', false).valid).toBe(true);
      expect(isValidCorsOrigin('http://127.0.0.1:3000', false).valid).toBe(true);
    });
  });

  describe('Exigences de Sécurité en Production', () => {
    it('devrait rejeter BETTER_AUTH_URL en HTTP simple en production', () => {
      const dangerous = {
        ...validProductionEnv,
        BETTER_AUTH_URL: 'http://boutica-cloud.onrender.com',
      };
      const result = envSchema.safeParse(dangerous);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.includes('BETTER_AUTH_URL'));
        expect(issue?.message).toContain('strictly use HTTPS in production');
      }
    });

    it('devrait rejeter BETTER_AUTH_URL ciblant une IP privée (SSRF/Metadata) en production', () => {
      const dangerous = {
        ...validProductionEnv,
        BETTER_AUTH_URL: 'https://169.254.169.254',
      };
      const result = envSchema.safeParse(dangerous);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.includes('BETTER_AUTH_URL'));
        expect(issue?.message).toContain('private, loopback, or local network address');
      }
    });

    it('devrait rejeter CORS_ORIGIN avec wildcard en production', () => {
      const dangerous = {
        ...validProductionEnv,
        CORS_ORIGIN: '*',
      };
      const result = envSchema.safeParse(dangerous);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.includes('CORS_ORIGIN'));
        expect(issue?.message).toContain('wildcard "*" est interdit');
      }
    });

    it('devrait rejeter CORS_ORIGIN contenant une origine avec chemin en production', () => {
      const dangerous = {
        ...validProductionEnv,
        CORS_ORIGIN: 'https://app.boutica.cloud/dashboard',
      };
      const result = envSchema.safeParse(dangerous);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.includes('CORS_ORIGIN'));
        expect(issue?.message).toContain('ne doit pas comporter de chemin d\'accès');
      }
    });
  });

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
      const { DATABASE_URL: _databaseUrl, ...incomplete } = validProductionEnv;
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
  });
});
