import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Novu } from '@novu/node';
import type { Env } from '../../config/env.schema';
import { NovuEventType } from './novu.types';

@Injectable()
export class NovuClientService {
  private readonly logger = new Logger(NovuClientService.name);
  private readonly novu: Novu | null = null;
  private readonly isConfigured: boolean = false;

  constructor(private readonly config: ConfigService<Env, true>) {
    const apiKey = this.config.get<string>('NOVU_API_KEY', { infer: true });
    const backendUrl = this.config.get<string>('NOVU_BACKEND_URL', { infer: true });

    if (apiKey && typeof apiKey === 'string' && apiKey.trim() !== '') {
      try {
        const trimmedKey = apiKey.trim();
        const trimmedUrl = backendUrl && typeof backendUrl === 'string' ? backendUrl.trim() : undefined;
        this.novu = new Novu(trimmedKey, trimmedUrl ? { backendUrl: trimmedUrl } : undefined);
        this.isConfigured = true;
        this.logger.log('Client Novu initialisé avec succès');
      } catch (err: any) {
        this.logger.error(`Erreur d'initialisation de Novu : ${err.message}`);
      }
    } else {
      this.logger.warn('NOVU_API_KEY non configurée — Novu fonctionne en mode pass-through');
    }
  }

  /**
   * Déclenche un workflow de notification Novu avec clé de déduplication stricte.
   */
  async triggerWorkflow(
    workflowId: NovuEventType,
    recipientId: string,
    payload: Record<string, unknown>,
    deduplicationKey: string,
  ): Promise<{ success: boolean; transactionId?: string; error?: string }> {
    if (!this.isConfigured || !this.novu) {
      this.logger.debug(
        `[Novu Pass-Through] Déclenchement simulé de l'événement '${workflowId}' pour destinataire '${recipientId}' (clé: ${deduplicationKey})`,
      );
      return {
        success: true,
        transactionId: `mock-tx-${Date.now()}-${deduplicationKey}`,
      };
    }

    try {
      const response = await this.novu.trigger(workflowId, {
        to: {
          subscriberId: recipientId,
        },
        payload: payload as any,
        transactionId: deduplicationKey,
      });

      const data = response.data;
      this.logger.log(
        `[Novu] Événement '${workflowId}' accepté par Novu (transactionId: ${data?.transactionId || 'ok'})`,
      );

      return {
        success: true,
        transactionId: data?.transactionId,
      };
    } catch (err: any) {
      const errMsg = err?.response?.data?.message || err?.message || 'Erreur inconnue de transmission Novu';
      this.logger.error(`[Novu] Échec du déclenchement du workflow '${workflowId}': ${errMsg}`);
      return {
        success: false,
        error: errMsg,
      };
    }
  }

  get isReady(): boolean {
    return this.isConfigured;
  }
}
