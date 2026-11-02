import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DatabaseService } from "../../infrastructure/database/database";
import {
  businesses,
  businessActivities,
  businessMembers,
  businessModuleConfigurations,
  deviceSerials,
  users,
} from "../../infrastructure/database/schema";
import {
  BUSINESS_MODULES,
  BUSINESS_SECTORS,
  BusinessSectorType,
  SECTOR_ACTIVITIES,
  validateActivitiesForSector,
} from "./business-taxonomy";
import {
  ModuleConfigItemDto,
  RegisterDeviceSerialDto,
  UpdateBusinessProfileDto,
} from "./dto/business.dto";

@Injectable()
export class BusinessService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Retourne la taxonomie commerciale complète (Secteurs, Activités, Modules disponibles).
   */
  getTaxonomy() {
    return {
      sectors: Object.values(BUSINESS_SECTORS),
      activitiesBySector: SECTOR_ACTIVITIES,
      modulesCatalogue: BUSINESS_MODULES,
    };
  }

  /**
   * Récupère le profil complet de l'entreprise, ses activités actives, sa configuration modulaire et ses membres.
   */
  async getBusinessProfile(businessId: string) {
    const [business] = await this.db.db
      .select()
      .from(businesses)
      .where(eq(businesses.id, businessId));

    if (!business) {
      throw new NotFoundException("Entreprise introuvable");
    }

    // Récupération des activités
    const activityRows = await this.db.db
      .select()
      .from(businessActivities)
      .where(eq(businessActivities.businessId, businessId));

    // Récupération des configurations de modules
    const moduleRows = await this.db.db
      .select()
      .from(businessModuleConfigurations)
      .where(eq(businessModuleConfigurations.businessId, businessId));

    // Récupération des membres
    const memberRows = await this.db.db
      .select({
        membershipId: businessMembers.id,
        userId: businessMembers.userId,
        role: businessMembers.role,
        name: users.name,
        email: users.email,
        createdAt: businessMembers.createdAt,
      })
      .from(businessMembers)
      .innerJoin(users, eq(businessMembers.userId, users.id))
      .where(eq(businessMembers.businessId, businessId));

    const activeActivities = activityRows.filter((a) => a.isActive).map((a) => a.activity);
    const inactiveActivities = activityRows.filter((a) => !a.isActive).map((a) => a.activity);

    return {
      id: business.id,
      name: business.name,
      currency: business.currency,
      phone: business.phone,
      sector: business.sector as BusinessSectorType,
      address: business.address,
      createdAt: business.createdAt,
      updatedAt: business.updatedAt,
      activities: {
        active: activeActivities,
        inactive: inactiveActivities,
        all: activityRows,
      },
      modules: moduleRows.map((m) => ({
        module: m.module,
        isEnabled: m.isEnabled,
        settings: m.settings,
      })),
      members: memberRows,
    };
  }

  /**
   * Met à jour les informations de base de l'entreprise.
   */
  async updateBusinessProfile(businessId: string, dto: UpdateBusinessProfileDto) {
    const [existing] = await this.db.db
      .select()
      .from(businesses)
      .where(eq(businesses.id, businessId));

    if (!existing) {
      throw new NotFoundException("Entreprise introuvable");
    }

    const updates: Partial<typeof businesses.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (dto.name !== undefined) updates.name = dto.name.trim();
    if (dto.currency !== undefined) updates.currency = dto.currency.trim().toUpperCase();
    if (dto.phone !== undefined) updates.phone = dto.phone.trim();
    if (dto.address !== undefined) updates.address = dto.address.trim();
    if (dto.sector !== undefined) updates.sector = dto.sector;

    const [updated] = await this.db.db
      .update(businesses)
      .set(updates)
      .where(eq(businesses.id, businessId))
      .returning();

    return updated;
  }

  /**
   * Met à jour les activités commerciales de l'entreprise.
   * RÈGLE CRITIQUE DE CONSERVATION :
   * Ne supprime JAMAIS de ligne d'activité, de produit, de vente ou de stock.
   * Désactive (isActive = false) les activités retirées et active celles sélectionnées.
   */
  async updateBusinessActivities(businessId: string, selectedActivities: string[]) {
    const [business] = await this.db.db
      .select()
      .from(businesses)
      .where(eq(businesses.id, businessId));

    if (!business) {
      throw new NotFoundException("Entreprise introuvable");
    }

    const sector = (business.sector as BusinessSectorType) || BUSINESS_SECTORS.QUINCAILLERIE;

    // Validation de compatibilité avec le secteur de l'entreprise
    const validation = validateActivitiesForSector(sector, selectedActivities);
    if (!validation.valid) {
      throw new BadRequestException(
        `Les activités suivantes ne sont pas compatibles avec le secteur ${sector} : ${validation.invalidCodes.join(", ")}`,
      );
    }

    // Récupération des activités actuellement existantes en base
    const existingRows = await this.db.db
      .select()
      .from(businessActivities)
      .where(eq(businessActivities.businessId, businessId));

    const existingMap = new Map(existingRows.map((r) => [r.activity, r]));
    const selectedSet = new Set(selectedActivities);

    await this.db.db.transaction(async (tx) => {
      // 1. Mettre à jour les activités existantes (activer ou désactiver sans supprimer)
      for (const row of existingRows) {
        const shouldBeActive = selectedSet.has(row.activity);
        if (row.isActive !== shouldBeActive) {
          await tx
            .update(businessActivities)
            .set({ isActive: shouldBeActive, updatedAt: new Date() })
            .where(eq(businessActivities.id, row.id));
        }
      }

      // 2. Insérer les nouvelles activités sélectionnées qui n'existaient pas encore
      for (const act of selectedActivities) {
        if (!existingMap.has(act)) {
          await tx.insert(businessActivities).values({
            businessId,
            activity: act,
            isActive: true,
          });
        }
      }
    });

    const refreshed = await this.db.db
      .select()
      .from(businessActivities)
      .where(eq(businessActivities.businessId, businessId));

    return {
      success: true,
      businessId,
      sector,
      activeActivities: refreshed.filter((a) => a.isActive).map((a) => a.activity),
      inactiveActivities: refreshed.filter((a) => !a.isActive).map((a) => a.activity),
      allActivities: refreshed,
    };
  }

  /**
   * Configure ou active/désactive les modules fonctionnels de l'entreprise.
   * Préserve l'intégrité et l'historique complet sans perte de données.
   */
  async updateBusinessModules(businessId: string, modules: ModuleConfigItemDto[]) {
    const [business] = await this.db.db
      .select()
      .from(businesses)
      .where(eq(businesses.id, businessId));

    if (!business) {
      throw new NotFoundException("Entreprise introuvable");
    }

    for (const item of modules) {
      const [existing] = await this.db.db
        .select()
        .from(businessModuleConfigurations)
        .where(
          and(
            eq(businessModuleConfigurations.businessId, businessId),
            eq(businessModuleConfigurations.module, item.module),
          ),
        );

      if (existing) {
        await this.db.db
          .update(businessModuleConfigurations)
          .set({
            isEnabled: item.isEnabled,
            settings: item.settings ?? existing.settings,
            updatedAt: new Date(),
          })
          .where(eq(businessModuleConfigurations.id, existing.id));
      } else {
        await this.db.db.insert(businessModuleConfigurations).values({
          businessId,
          module: item.module,
          isEnabled: item.isEnabled,
          settings: item.settings ?? {},
        });
      }
    }

    const refreshed = await this.db.db
      .select()
      .from(businessModuleConfigurations)
      .where(eq(businessModuleConfigurations.businessId, businessId));

    return {
      success: true,
      businessId,
      modules: refreshed.map((m) => ({
        module: m.module,
        isEnabled: m.isEnabled,
        settings: m.settings,
      })),
    };
  }

  /**
   * Traçabilité unitaire des numéros de série et IMEI (Électronique).
   */
  async getDeviceSerials(businessId: string, variantId?: string) {
    const filters = [eq(deviceSerials.businessId, businessId)];
    if (variantId) {
      filters.push(eq(deviceSerials.variantId, variantId));
    }

    return this.db.db
      .select()
      .from(deviceSerials)
      .where(and(...filters))
      .orderBy(desc(deviceSerials.createdAt));
  }

  async registerDeviceSerial(businessId: string, dto: RegisterDeviceSerialDto) {
    const [created] = await this.db.db
      .insert(deviceSerials)
      .values({
        businessId,
        variantId: dto.variantId,
        serialNumber: dto.serialNumber?.trim() || null,
        imei: dto.imei?.trim() || null,
        warrantyMonths: dto.warrantyMonths ?? 0,
        notes: dto.notes?.trim() || null,
        status: "IN_STOCK",
      })
      .returning();

    return created;
  }
}
