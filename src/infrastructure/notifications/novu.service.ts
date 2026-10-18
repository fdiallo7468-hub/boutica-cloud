import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Novu } from "@novu/node";
import type { Env } from "../../config/env.schema";
import { QUEUES, QueueService } from "../jobs/queue.service";

export interface StockAlertPayload {
  sku: string;
  productName: string;
  currentStock: number;
  threshold: number;
  recipientEmail?: string;
}

export interface SaleCompletedPayload {
  saleId: string;
  total: string;
  itemsCount: number;
  recipientEmail?: string;
}

export interface ReportReadyPayload {
  reportType: string;
  downloadUrl: string;
  recipientEmail?: string;
}

@Injectable()
export class NovuService {
  private readonly logger = new Logger(NovuService.name);
  private readonly novu: Novu | null = null;
  private readonly isConfigured: boolean = false;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly queueService: QueueService,
  ) {
    const apiKey = this.config.get("NOVU_API_KEY", { infer: true });
    const backendUrl = this.config.get("NOVU_BACKEND_URL", { infer: true });

    if (apiKey && apiKey.trim()) {
      try {
        this.novu = new Novu(apiKey.trim(), { backendUrl: backendUrl || undefined });
        this.isConfigured = true;
        this.logger.log("Service de notifications Novu initialisé avec succès");
      } catch (err: any) {
        this.logger.warn(`Échec initialisation Novu : ${err.message}. Mode simulation actif.`);
      }
    } else {
      this.logger.log("NOVU_API_KEY non configurée — Novu fonctionne en mode journalisation/simulation");
    }
  }

  get configured(): boolean {
    return this.isConfigured;
  }

  async triggerStockAlert(businessId: string, payload: StockAlertPayload): Promise<{ success: boolean; async: boolean }> {
    await this.queueService.addJob(QUEUES.NOTIFICATIONS, "stock-alert", {
      businessId,
      ...payload,
    });

    if (!this.isConfigured || !this.novu) {
      this.logger.debug(
        `[Simulation Novu] Alerte stock bas déclenchée pour [${payload.sku}] ${payload.productName} (Stock: ${payload.currentStock} <= Seuil: ${payload.threshold})`,
      );
      return { success: true, async: true };
    }

    try {
      await this.novu.trigger("stock-alert", {
        to: {
          subscriberId: `tenant-${businessId}`,
          email: payload.recipientEmail,
        },
        payload: {
          businessId,
          sku: payload.sku,
          productName: payload.productName,
          currentStock: payload.currentStock,
          threshold: payload.threshold,
        },
      });
      return { success: true, async: true };
    } catch (err: any) {
      this.logger.error(`Erreur déclenchement workflow Novu stock-alert: ${err.message}`);
      return { success: false, async: true };
    }
  }

  async triggerSaleCompleted(businessId: string, payload: SaleCompletedPayload): Promise<{ success: boolean; async: boolean }> {
    await this.queueService.addJob(QUEUES.NOTIFICATIONS, "sale-completed", {
      businessId,
      ...payload,
    });

    if (!this.isConfigured || !this.novu) {
      this.logger.debug(
        `[Simulation Novu] Notification de vente déclenchée pour ${payload.saleId} (Montant: ${payload.total})`,
      );
      return { success: true, async: true };
    }

    try {
      await this.novu.trigger("sale-completed", {
        to: {
          subscriberId: `tenant-${businessId}`,
          email: payload.recipientEmail,
        },
        payload: {
          saleId: payload.saleId,
          total: payload.total,
          itemsCount: payload.itemsCount,
        },
      });
      return { success: true, async: true };
    } catch (err: any) {
      this.logger.error(`Erreur déclenchement Novu sale-completed: ${err.message}`);
      return { success: false, async: true };
    }
  }

  async triggerReportReady(businessId: string, payload: ReportReadyPayload): Promise<{ success: boolean; async: boolean }> {
    await this.queueService.addJob(QUEUES.NOTIFICATIONS, "report-ready", {
      businessId,
      ...payload,
    });

    if (!this.isConfigured || !this.novu) {
      this.logger.debug(
        `[Simulation Novu] Rapport ${payload.reportType} prêt pour téléchargement: ${payload.downloadUrl}`,
      );
      return { success: true, async: true };
    }

    try {
      await this.novu.trigger("report-ready", {
        to: {
          subscriberId: `tenant-${businessId}`,
          email: payload.recipientEmail,
        },
        payload: {
          reportType: payload.reportType,
          downloadUrl: payload.downloadUrl,
        },
      });
      return { success: true, async: true };
    } catch (err: any) {
      this.logger.error(`Erreur déclenchement Novu report-ready: ${err.message}`);
      return { success: false, async: true };
    }
  }
}
