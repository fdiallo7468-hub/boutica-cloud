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
import {
  businesses,
  businessActivities,
  businessMembers,
  businessModuleConfigurations,
  users,
} from "../../infrastructure/database/schema";
import {
  BUSINESS_SECTORS,
  BusinessSectorType,
  getDefaultModulesForSector,
  SECTOR_ACTIVITIES,
  validateActivitiesForSector,
} from "../business/business-taxonomy";
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
    const rawSector = dto.businessSector?.trim()?.toUpperCase();
    const sector: BusinessSectorType =
      rawSector === BUSINESS_SECTORS.ELECTRONIQUE
        ? BUSINESS_SECTORS.ELECTRONIQUE
        : BUSINESS_SECTORS.QUINCAILLERIE;

    // Validate activities if provided
    let chosenActivities = dto.businessActivities;
    if (chosenActivities && chosenActivities.length > 0) {
      const validation = validateActivitiesForSector(sector, chosenActivities);
      if (!validation.valid) {
        throw new BadRequestException(
          `Les activités suivantes ne sont pas valides pour le secteur ${sector} : ${validation.invalidCodes.join(", ")}`,
        );
      }
    } else {
      // Default to all standard activities of the sector
      chosenActivities = SECTOR_ACTIVITIES[sector].map((a) => a.code);
    }

    const address = dto.businessAddress?.trim() || null;
    const personalPhone = dto.personalPhone?.trim() || null;

    // Lock and re-check the user inside the same transaction. This prevents
    // two simultaneous onboarding requests from creating two businesses.
    const result = await this.db.db.transaction(async (tx) => {
      const [lockedUser] = await tx
        .select({ id: users.id, businessId: users.businessId })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');

      if (!lockedUser) {
        throw new UnauthorizedException("Utilisateur non trouvé en base");
      }
      if (lockedUser.businessId) {
        throw new BadRequestException("Une entreprise est déjà rattachée à cet utilisateur");
      }

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

      // 1. Insert business membership
      const memberInsert = tx
        .insert(businessMembers)
        .values({
          businessId: business.id,
          userId,
          role: "OWNER",
        });
      if (typeof (memberInsert as any)?.onConflictDoNothing === "function") {
        await (memberInsert as any).onConflictDoNothing();
      } else {
        await memberInsert;
      }

      // 2. Insert activities
      const activityRows = chosenActivities!.map((act) => ({
        businessId: business.id,
        activity: act,
        isActive: true,
      }));
      if (activityRows.length > 0) {
        const actInsert = tx.insert(businessActivities).values(activityRows);
        if (typeof (actInsert as any)?.onConflictDoNothing === "function") {
          await (actInsert as any).onConflictDoNothing();
        } else {
          await actInsert;
        }
      }

      // 3. Insert default module configurations
      const defaultModules = getDefaultModulesForSector(sector).map((modCode) => ({
        businessId: business.id,
        module: modCode,
        isEnabled: true,
        settings: {},
      }));
      if (defaultModules.length > 0) {
        const modInsert = tx.insert(businessModuleConfigurations).values(defaultModules);
        if (typeof (modInsert as any)?.onConflictDoNothing === "function") {
          await (modInsert as any).onConflictDoNothing();
        } else {
          await modInsert;
        }
      }

      // 4. Update user active businessId
      await tx
        .update(users)
        .set({
          businessId: business.id,
          role: "OWNER",
          personalPhone: personalPhone ?? undefined,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId))
        .returning({ id: users.id });

      return {
        business,
        activities: chosenActivities,
        modules: defaultModules.map((m) => m.module),
      };
    });

    return {
      message: "Entreprise configurée avec succès",
      business: {
        id: result.business.id,
        name: result.business.name,
        currency: result.business.currency,
        phone: result.business.phone,
        sector: result.business.sector,
        address: result.business.address,
        activities: result.activities,
        modules: result.modules,
      },
      role: "OWNER",
    };
  }
}
