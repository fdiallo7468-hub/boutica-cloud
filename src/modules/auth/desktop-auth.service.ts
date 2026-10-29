import { Injectable, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "crypto";

export interface ExchangePayload {
  sessionToken: string;
  user: {
    id: string;
    email: string;
    name?: string | null;
    businessId?: string | null;
    role?: string | null;
    [key: string]: any;
  };
  createdAt: number;
}

@Injectable()
export class DesktopAuthService {
  private readonly pendingCodes = new Map<string, ExchangePayload>();
  private readonly TTL_MS = 60_000; // 60 secondes maximum

  constructor() {
    // Nettoyage régulier des codes expirés
    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [code, data] of this.pendingCodes.entries()) {
        if (now - data.createdAt > this.TTL_MS) {
          this.pendingCodes.delete(code);
        }
      }
    }, 30_000);

    if (cleanupInterval.unref) {
      cleanupInterval.unref();
    }
  }

  /**
   * Crée un code d'échange éphémère (60 secondes) à usage unique
   */
  createExchangeCode(sessionToken: string, user: any): string {
    if (!sessionToken || typeof sessionToken !== "string") {
      throw new Error("Jeton de session invalide pour la génération du code d'échange");
    }

    const code = randomBytes(32).toString("hex");
    this.pendingCodes.set(code, {
      sessionToken,
      user: {
        id: user?.id,
        email: user?.email,
        name: user?.name ?? null,
        businessId: user?.businessId ?? null,
        role: user?.role ?? null,
      },
      createdAt: Date.now(),
    });

    return code;
  }

  /**
   * Valide et consomme atomiquement le code d'échange (single-use)
   */
  consumeExchangeCode(code: string): { sessionToken: string; user: any } {
    if (!code || typeof code !== "string" || !/^[a-f0-9]{64}$/.test(code.trim())) {
      throw new UnauthorizedException("Code d'échange invalide ou format incorrect");
    }

    const trimmed = code.trim();
    const data = this.pendingCodes.get(trimmed);

    if (!data) {
      throw new UnauthorizedException("Code d'échange invalide ou déjà consommé");
    }

    // Consommation atomique immédiate
    this.pendingCodes.delete(trimmed);

    if (Date.now() - data.createdAt > this.TTL_MS) {
      throw new UnauthorizedException("Le code d'échange a expiré");
    }

    return {
      sessionToken: data.sessionToken,
      user: data.user,
    };
  }

  /**
   * Vérifie le nombre de codes en attente (utile pour les tests unitaires)
   */
  getPendingCodesCount(): number {
    return this.pendingCodes.size;
  }
}
