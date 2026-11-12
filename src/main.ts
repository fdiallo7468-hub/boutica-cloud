import { toNodeHandler } from "better-auth/node";
import { auth } from "./auth/auth";
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import type { Env } from './config/env.schema';
import { ArcjetService } from './infrastructure/security/arcjet.service';

async function bootstrap() {
  // v2.0: Nest's built-in body parser is disabled — Better Auth needs the
  // raw, un-parsed request stream for its own routes (it does its own
  // parsing internally). `express.json()` is added back explicitly below,
  // registered AFTER AuthModule's handler is already wired by
  // NestFactory.create(), so Better Auth still sees requests first/raw and
  // every other route still gets `req.body` populated exactly as before —
  // see the current Better Auth NestJS integration docs, which document
  // this exact ordering requirement.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  // Ensure SIGTERM/SIGINT close Nest providers cleanly (notably PostgreSQL pools).
  app.enableShutdownHooks();
  const logger = new Logger('Bootstrap');

  const expressApp = app.getHttpAdapter().getInstance();
  // 1. Respect the configured reverse-proxy hop count for forwarded headers.
  expressApp.set('trust proxy', 1);

  // 2. Gestionnaire Better Auth natif direct : préserve l\x27intégralité du chemin et des paramètres de requête (query params)
  // Better Auth is mounted directly in Express, outside Nest's router.
  // Nest global guards (including ArcjetGuard) therefore do not run for
  // these endpoints; enforce the same Arcjet policy before the auth handler.
  const arcjet = app.get(ArcjetService);
  expressApp.use('/api/auth', async (req: any, res: any, next: (err?: unknown) => void) => {
    try {
      const decision = await arcjet.protect(req);
      if (decision?.isErrored?.()) {
        if (arcjet.production) {
          return res.status(503).json({ statusCode: 503, message: 'Application protection could not evaluate this request' });
        }
        return next();
      }

      if (decision?.isDenied?.()) {
        const reason = decision.reason;
        if (reason?.isRateLimit?.()) {
          return res.status(429).json({
            statusCode: 429,
            error: 'Too Many Requests',
            message: 'Taux de requêtes trop élevé. Veuillez réessayer dans quelques instants.',
          });
        }
        return res.status(403).json({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Requête bloquée par la politique de sécurité applicative.',
        });
      }

      return next();
    } catch (error) {
      logger.error('Arcjet failed to evaluate a Better Auth request', error instanceof Error ? error.stack : undefined);
      if (arcjet.production) {
        return res.status(503).json({ statusCode: 503, message: 'Application protection is temporarily unavailable' });
      }
      return next();
    }
  });

  expressApp.use('/api/auth', (req: any, res: any) => {
    return toNodeHandler(auth)(req, res);
  });
  // ROUND 2 FIX: env vars used to be read raw off process.env here, with a
  // manual fail-closed check duplicated just for CORS_ORIGIN. Everything
  // this file needs is now validated once, centrally, in
  // src/config/env.schema.ts — ConfigService just serves the already-typed,
  // already-validated result.
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // FIX (P1-4): the original code called `setGlobalPrefix('api')` on top of
  // controllers that already declare their full path as `api/v1/...`
  // (e.g. `@Controller('api/v1/products')`). setGlobalPrefix prepends its
  // prefix unconditionally, so the actual routes were `/api/api/v1/...`,
  // not the `/api/v1/...` the README documents. Every controller already
  // states its own explicit versioned path, so no global prefix is applied
  // here — `health` deliberately stays unprefixed, matching common
  // infra/health-check conventions, and Better Auth's routes keep their own
  // `/api/auth/*` convention (see src/auth/auth.ts).
  app.use(helmet());
  app.use(express.json());

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      // Reject with a 400 that lists every offending field instead of only
      // the first one — more useful for API consumers debugging a payload.
      stopAtFirstError: false,
    }),
  );

  // FIX (P1-3, now enforced centrally): the previous default (`?? true`)
  // reflected ANY origin when CORS_ORIGIN wasn't set, which is an unsafe
  // default for a production deployment. envSchema's .refine() already
  // guarantees CORS_ORIGIN is set once NODE_ENV=production — the app would
  // not have reached this line otherwise — so this is just parsing, not
  // re-enforcing the policy.
  const corsOriginRaw = config.get('CORS_ORIGIN', { infer: true });
  const corsOrigins = corsOriginRaw
    ? corsOriginRaw.split(',').map((o) => o.trim()).filter(Boolean)
    : ['http://localhost:5173', 'http://localhost:3000'];

  app.enableCors({
    origin: (requestOrigin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Autoriser les requêtes sans en-tête Origin (ex: clients mobiles natifs, desktop, server-to-server)
      if (!requestOrigin) {
        return callback(null, true);
      }
      if (corsOrigins.includes(requestOrigin)) {
        return callback(null, true);
      }
      logger.warn(`Requête CORS bloquée pour l\x27origine non autorisée : ${requestOrigin}`);
      return callback(new Error(`CORS policy: origin ${requestOrigin} not allowed`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Idempotency-Key'],
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Boutica API')
    .setDescription('Boutica commerce management API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  const configuredPort = config.get('PORT', { infer: true });
  const port = configuredPort || 3000;
  await app.listen(port);
  logger.log(`Boutica backend listening on port ${port}`);
}
bootstrap();
