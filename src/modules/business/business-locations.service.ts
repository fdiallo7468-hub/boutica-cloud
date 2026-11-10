import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { DatabaseService } from "../../infrastructure/database/database";
import { businessLocations } from "../../infrastructure/database/schema";
import {
  CreateBusinessLocationDto,
  UpdateBusinessLocationDto,
} from "./dto/business-location.dto";

@Injectable()
export class BusinessLocationsService {
  constructor(private readonly database: DatabaseService) {}

  async list(businessId: string) {
    return this.database.db
      .select()
      .from(businessLocations)
      .where(eq(businessLocations.businessId, businessId))
      .orderBy(asc(businessLocations.isDefault), asc(businessLocations.name));
  }

  async create(businessId: string, dto: CreateBusinessLocationDto) {
    const code = dto.code.trim().toUpperCase();
    const name = dto.name.trim();

    return this.database.db.transaction(async (tx) => {
      if (dto.isDefault) {
        await tx
          .update(businessLocations)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(eq(businessLocations.businessId, businessId));
      }

      const [created] = await tx
        .insert(businessLocations)
        .values({
          businessId,
          code,
          name,
          address: dto.address?.trim() || null,
          phone: dto.phone?.trim() || null,
          isDefault: dto.isDefault ?? false,
          isActive: true,
        })
        .returning();

      return created;
    });
  }

  async update(
    businessId: string,
    locationId: string,
    dto: UpdateBusinessLocationDto,
  ) {
    const [existing] = await this.database.db
      .select()
      .from(businessLocations)
      .where(and(
        eq(businessLocations.id, locationId),
        eq(businessLocations.businessId, businessId),
      ))
      .limit(1);

    if (!existing) throw new NotFoundException("Établissement introuvable");

    if (dto.isActive === false && existing.isDefault) {
      throw new BadRequestException(
        "Définissez d'abord un autre établissement principal avant de désactiver celui-ci",
      );
    }

    const updates: Partial<typeof businessLocations.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (dto.name !== undefined) updates.name = dto.name.trim();
    if (dto.address !== undefined) updates.address = dto.address?.trim() || null;
    if (dto.phone !== undefined) updates.phone = dto.phone?.trim() || null;
    if (dto.isActive !== undefined) updates.isActive = dto.isActive;

    const [updated] = await this.database.db
      .update(businessLocations)
      .set(updates)
      .where(and(
        eq(businessLocations.id, locationId),
        eq(businessLocations.businessId, businessId),
      ))
      .returning();

    return updated;
  }

  async setDefault(businessId: string, locationId: string) {
    return this.database.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(businessLocations)
        .where(and(
          eq(businessLocations.id, locationId),
          eq(businessLocations.businessId, businessId),
        ))
        .limit(1);

      if (!target) throw new NotFoundException("Établissement introuvable");
      if (!target.isActive) {
        throw new BadRequestException("Un établissement inactif ne peut pas devenir principal");
      }

      await tx
        .update(businessLocations)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(businessLocations.businessId, businessId));

      const [updated] = await tx
        .update(businessLocations)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(and(
          eq(businessLocations.id, locationId),
          eq(businessLocations.businessId, businessId),
        ))
        .returning();

      return updated;
    });
  }
}
