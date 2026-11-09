import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';

@Injectable()
export class ArcjetService implements OnModuleInit {
  private readonly logger = new Logger(ArcjetService.name);
  private aj: any = null;
  private isEnabled = false;

  constructor(private readonly config: ConfigService<Env, true>) {}

  async onModuleInit() {
    const key = this.config.get('ARCJET_KEY', { infer: true });
    const isProduction = this.config.get('NODE_ENV', { infer: true }) === 'production';
    if (!key || !key.trim()) {
      if (isProduction) {
        throw new Error('ARCJET_KEY is required in production; Arcjet protection cannot be disabled.');
      }
      this.logger.warn('ARCJET_KEY is not configured; Arcjet is disabled in this non-production environment.');
      return;
    }

    if (key && key.trim()) {
      try {
        const { default: arcjet, shield, detectBot, slidingWindow } = await (eval('import("@arcjet/node")') as Promise<any>);
        this.aj = arcjet({
          key: key.trim(),
          characteristics: ['ip.src'],
          rules: [
            shield({ mode: 'LIVE' }),
            detectBot({
              mode: 'LIVE',
              allow: ['CATEGORY:SEARCH_ENGINE', 'CATEGORY:MONITOR'],
            }),
            slidingWindow({
              mode: 'LIVE',
              interval: '1m',
              max: 120,
            }),
          ],
        });
        this.isEnabled = true;
        this.logger.log('Arcjet Security activé avec succès en mode LIVE');
      } catch (err: any) {
        this.logger.error(`Arcjet initialization failed: ${err instanceof Error ? err.message : 'unknown error'}`);
        if (isProduction) {
          throw new Error('Arcjet initialization failed in production; refusing to start without protection.');
        }
      }
    }
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  get production(): boolean {
    return this.config.get('NODE_ENV', { infer: true }) === 'production';
  }

  async protect(req: any) {
    if (!this.isEnabled || !this.aj) {
      if (this.production) {
        throw new Error('Arcjet protection is unavailable in production');
      }
      return {
        isDenied: () => false,
        isErrored: () => false,
        reason: null,
      };
    }
    return this.aj.protect(req);
  }
}
