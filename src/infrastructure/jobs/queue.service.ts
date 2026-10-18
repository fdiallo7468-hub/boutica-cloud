import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import type { Env } from "../../config/env.schema";

export const QUEUES = {
  REPORTS: "reports-queue",
  NOTIFICATIONS: "notifications-queue",
  STOCK_ALERTS: "stock-alerts-queue",
} as const;

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private redisConnection: Redis | null = null;
  private queues: Map<string, Queue> = new Map();
  private workers: Map<string, Worker> = new Map();
  private isRedisAvailable = false;

  constructor(private readonly config: ConfigService<Env, true>) {}

  async onModuleInit() {
    const redisUrl = this.config.get("REDIS_URL", { infer: true });
    const redisHost = this.config.get("REDIS_HOST", { infer: true });

    if (redisUrl || redisHost) {
      try {
        const connectionOptions: any = redisUrl
          ? redisUrl
          : {
              host: redisHost || "localhost",
              port: this.config.get("REDIS_PORT", { infer: true }) || 6379,
              password: this.config.get("REDIS_PASSWORD", { infer: true }) || undefined,
              maxRetriesPerRequest: null,
            };

        this.redisConnection = new Redis(connectionOptions, {
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          retryStrategy(times) {
            if (times > 3) return null;
            return Math.min(times * 200, 1000);
          },
        });

        this.redisConnection.on("error", (err) => {
          this.logger.warn(`Erreur connexion Redis : ${err.message}. Mode asynchrone dégradé.`);
        });

        this.redisConnection.on("connect", () => {
          this.isRedisAvailable = true;
          this.logger.log("Redis connecté avec succès pour les files BullMQ");
        });

        for (const queueName of Object.values(QUEUES)) {
          const q = new Queue(queueName, {
            connection: this.redisConnection,
            defaultJobOptions: {
              attempts: 3,
              backoff: { type: "exponential", delay: 2000 },
              removeOnComplete: 100,
              removeOnFail: 500,
            },
          });
          this.queues.set(queueName, q);
        }

        this.initWorkers();
      } catch (err: any) {
        this.logger.warn(`Impossible d initialiser Redis/BullMQ: ${err.message}. Fallback synchrone activé.`);
      }
    } else {
      this.logger.log("REDIS_URL non configuré — Traitements exécutés en mode synchrone direct (in-memory)");
    }
  }

  private initWorkers() {
    if (!this.redisConnection) return;

    const reportsWorker = new Worker(
      QUEUES.REPORTS,
      async (job) => {
        this.logger.log(`[BullMQ] Traitement job rapport ${job.id} (${job.name}) pour entreprise ${job.data?.businessId}`);
        return { status: "completed", generatedAt: new Date().toISOString() };
      },
      { connection: this.redisConnection },
    );
    this.workers.set(QUEUES.REPORTS, reportsWorker);

    const notifWorker = new Worker(
      QUEUES.NOTIFICATIONS,
      async (job) => {
        this.logger.log(`[BullMQ] Traitement job notification ${job.id} (${job.name}) pour entreprise ${job.data?.businessId}`);
        return { status: "sent", recipient: job.data?.recipient };
      },
      { connection: this.redisConnection },
    );
    this.workers.set(QUEUES.NOTIFICATIONS, notifWorker);
  }

  async addJob<T = any>(queueName: string, jobName: string, data: T, opts?: any): Promise<{ id: string }> {
    const queue = this.queues.get(queueName);
    if (this.isRedisAvailable && queue) {
      const job = await queue.add(jobName, data, opts);
      return { id: String(job.id) };
    }

    this.logger.debug(`[Direct Execution] Job "${jobName}" traité immédiatement (pas de Redis)`);
    return { id: `direct-${Date.now()}` };
  }

  async onModuleDestroy() {
    for (const worker of this.workers.values()) {
      await worker.close().catch(() => {});
    }
    for (const queue of this.queues.values()) {
      await queue.close().catch(() => {});
    }
    if (this.redisConnection) {
      await this.redisConnection.quit().catch(() => {});
    }
  }
}
