import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import type { Request } from "express";
import { auth } from "../../auth/auth";
import { DatabaseService } from "../../infrastructure/database/database";
import { businesses, users } from "../../infrastructure/database/schema";
import { CompleteBusinessOnboardingDto } from "./onboarding.dto";

@Controller("api/v1/auth/onboarding")
export class OnboardingController {
  constructor(private readonly db: DatabaseService) {}

  @Post("business")
  @HttpCode(HttpStatus.CREATED)
  async completeBusinessOnboarding(@Req() req: Request, @Body() dto: CompleteBusinessOnboardingDto) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session || !session.user) {
      throw new UnauthorizedException("Session requise pour finaliser l'onboarding");
    }

    const userId = session.user.id;

    // Verify current user record in database
    const [currentUser] = await this.db.db
      .select({ id: users.id, businessId: users.businessId })
      .from(users)
      .where(eq(users.id, userId));

    if (!currentUser) {
      throw new UnauthorizedException("Utilisateur non trouvé en base");
    }

    if (currentUser.businessId) {
      throw new BadRequestException("Une entreprise est déjà rattachée à cet utilisateur");
    }

    const currency = dto.currency?.toUpperCase() || "XOF";
    const name = dto.businessName.trim();
    const phone = dto.businessPhone?.trim() || null;
    const sector = dto.businessSector?.trim() || null;
    const address = dto.businessAddress?.trim() || null;
    const personalPhone = dto.personalPhone?.trim() || null;

    // Run creation in a transactional block
    const result = await this.db.db.transaction(async (tx) => {
      const [business] = await tx
        .insert(businesses)
        .values({
          name,
          currency,
          phone,
          sector,
          address,
        })
        .returning();

      if (!business) {
        throw new Error("Impossible d'insérer l'entreprise");
      }

      await tx
        .update(users)
        .set({
          businessId: business.id,
          role: "OWNER",
          personalPhone: personalPhone ?? undefined,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      return business;
    });

    return {
      message: "Entreprise configurée avec succès",
      business: {
        id: result.id,
        name: result.name,
        currency: result.currency,
        phone: result.phone,
        sector: result.sector,
        address: result.address,
      },
      role: "OWNER",
    };
  }
}
