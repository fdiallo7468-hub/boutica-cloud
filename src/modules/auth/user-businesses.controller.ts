import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
} from "class-validator";
import { and, eq, sql } from "drizzle-orm";
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

export class SwitchBusinessDto {
  @IsString()
  @IsNotEmpty()
  @Length(1, 64)
  businessId!: string;
}

export class CreateAdditionalBusinessDto {
  @IsString()
  @IsNotEmpty()
  @Length(2, 120)
  businessName!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/i)
  currency?: string;

  @IsOptional()
  @IsString()
  @Length(1, 30)
  phone?: string;

  @IsOptional()
  @IsString()
  @IsIn([BUSINESS_SECTORS.QUINCAILLERIE, BUSINESS_SECTORS.ELECTRONIQUE])
  businessSector?: BusinessSectorType;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  businessActivities?: string[];

  @IsOptional()
  @IsString()
  @Length(1, 250)
  address?: string;
}

@Controller("api/v1/auth")
export class UserBusinessesController {
  constructor(private readonly db: DatabaseService) {}

  private async getAuthenticatedUser(req: Request) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session || !session.user) {
      throw new UnauthorizedException("Session authentifiée requise");
    }
    return session.user;
  }

  /**
   * Liste toutes les entreprises rattachées à l'utilisateur connecté via business_members.
   */
  @Get("businesses")
  async listUserBusinesses(@Req() req: Request) {
    const user = await this.getAuthenticatedUser(req);

    // This control-plane route has no active tenant yet. Set only the
    // authenticated actor identity so RLS can expose that user's memberships.
    return this.db.baseDb.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT set_config('app.actor_user_id', ${user.id}, true)
      `);

      const [currentUser] = await tx
        .select({ businessId: users.businessId })
        .from(users)
        .where(eq(users.id, user.id));
      const activeBusinessId = currentUser?.businessId || null;

      const memberRows = await tx
        .select({
          membershipId: businessMembers.id,
          businessId: businessMembers.businessId,
          role: businessMembers.role,
          joinedAt: businessMembers.createdAt,
          name: businesses.name,
          currency: businesses.currency,
          phone: businesses.phone,
          sector: businesses.sector,
          address: businesses.address,
        })
        .from(businessMembers)
        .innerJoin(businesses, eq(businessMembers.businessId, businesses.id))
        .where(eq(businessMembers.userId, user.id));

      return {
        activeBusinessId,
        businesses: memberRows.map((b) => ({
          id: b.businessId,
          name: b.name,
          currency: b.currency,
          phone: b.phone,
          sector: b.sector,
          address: b.address,
          role: b.role,
          isActive: b.businessId === activeBusinessId,
        })),
      };
    });
  }

  /**
   * Bascule l'entreprise active pour le compte connecté.
   * Met à jour users.business_id et users.role de façon isolée et sécurisée.
   */
  @Post("switch-business")
  @HttpCode(HttpStatus.OK)
  async switchActiveBusiness(@Req() req: Request, @Body() body: SwitchBusinessDto) {
    const user = await this.getAuthenticatedUser(req);
    const targetBusinessId = body.businessId?.trim();

    if (!targetBusinessId) {
      throw new BadRequestException("Le paramètre 'businessId' est obligatoire");
    }

    return this.db.baseDb.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT set_config('app.actor_user_id', ${user.id}, true)
      `);

      const [membership] = await tx
        .select()
        .from(businessMembers)
        .where(and(
          eq(businessMembers.businessId, targetBusinessId),
          eq(businessMembers.userId, user.id),
        ));

      if (!membership) {
        throw new ForbiddenException(
          "Vous n'êtes pas membre de cette entreprise ou cet accès a été révoqué.",
        );
      }

      const [business] = await tx
        .select()
        .from(businesses)
        .where(eq(businesses.id, targetBusinessId));

      if (!business) {
        throw new NotFoundException("Entreprise introuvable");
      }

      await tx
        .update(users)
        .set({
          businessId: targetBusinessId,
          role: membership.role,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));

      return {
        success: true,
        message: `Bascule effectuée vers ${business.name}`,
        activeBusiness: {
          id: business.id,
          name: business.name,
          currency: business.currency,
          phone: business.phone,
          sector: business.sector,
          address: business.address,
          role: membership.role,
        },
      };
    });
  }

  /**
   * Permet à un utilisateur connecté de créer une nouvelle entreprise supplémentaire
   * sans déconnecter son compte ni altérer ses entreprises existantes.
   */
  @Post("businesses")
  @HttpCode(HttpStatus.CREATED)
  async createAdditionalBusiness(@Req() req: Request, @Body() body: CreateAdditionalBusinessDto) {
    const user = await this.getAuthenticatedUser(req);

    const name = body.businessName?.trim();
    if (!name || name.length < 2 || name.length > 120) {
      throw new BadRequestException("Le nom de l'entreprise doit comporter entre 2 et 120 caractères");
    }

    const rawSector = body.businessSector?.trim()?.toUpperCase();
    const sector: BusinessSectorType =
      rawSector === BUSINESS_SECTORS.ELECTRONIQUE
        ? BUSINESS_SECTORS.ELECTRONIQUE
        : BUSINESS_SECTORS.QUINCAILLERIE;

    let activities = body.businessActivities;
    if (activities && activities.length > 0) {
      const val = validateActivitiesForSector(sector, activities);
      if (!val.valid) {
        throw new BadRequestException(
          `Activités non valides pour le secteur ${sector} : ${val.invalidCodes.join(", ")}`,
        );
      }
    } else {
      activities = SECTOR_ACTIVITIES[sector].map((a) => a.code);
    }

    const currency = body.currency?.trim()?.toUpperCase() || "XOF";
    const phone = body.phone?.trim() || null;
    const address = body.address?.trim() || null;

    const result = await this.db.baseDb.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT set_config('app.actor_user_id', ${user.id}, true)
      `);

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

      await tx.execute(sql`
        SELECT set_config('app.business_id', ${business.id}, true)
      `);

      // Membership as OWNER
      await tx.insert(businessMembers).values({
        businessId: business.id,
        userId: user.id,
        role: "OWNER",
      });

      // Activities
      const actRows = activities!.map((act) => ({
        businessId: business.id,
        activity: act,
        isActive: true,
      }));
      if (actRows.length > 0) {
        await tx.insert(businessActivities).values(actRows).onConflictDoNothing();
      }

      // Modules
      const defaultModules = getDefaultModulesForSector(sector).map((modCode) => ({
        businessId: business.id,
        module: modCode,
        isEnabled: true,
        settings: {},
      }));
      if (defaultModules.length > 0) {
        await tx.insert(businessModuleConfigurations).values(defaultModules).onConflictDoNothing();
      }

      // Switch active business
      await tx
        .update(users)
        .set({
          businessId: business.id,
          role: "OWNER",
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));

      return business;
    });

    return {
      success: true,
      message: `Entreprise ${result.name} créée avec succès.`,
      business: {
        id: result.id,
        name: result.name,
        currency: result.currency,
        phone: result.phone,
        sector: result.sector,
        address: result.address,
        activities,
        role: "OWNER",
      },
    };
  }
}
