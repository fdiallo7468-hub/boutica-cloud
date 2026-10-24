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
        this.logger.warn(`Impossible d'initialiser Arcjet : ${err.message}. Mode simulation actif.`);
      }
    } else {
      this.logger.log('ARCJET_KEY non configurée — Arcjet fonctionne en mode pass-through');
    }
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  async protect(req: any) {
    if (!this.isEnabled || !this.aj) {
      return {
        isDenied: () => false,
        reason: null,
      };
    }
    return this.aj.protect(req);
  }
}
