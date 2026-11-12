import { PERMISSIONS } from '../auth/permissions/permission-catalog';
import { RequirePermissions } from '../auth/permissions/require-permissions.decorator';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Public } from "@thallesp/nestjs-better-auth";
import { CurrentTenant } from "../auth/current-tenant.decorator";
import { Tenant } from "../auth/tenant.type";
import { BusinessService } from "./business.service";
import {
  RegisterDeviceSerialDto,
  UpdateActivitiesDto,
  UpdateBusinessProfileDto,
  UpdateModulesDto,
} from "./dto/business.dto";

@ApiTags("business")
@Controller("api/v1/business")
export class BusinessController {
  constructor(private readonly businessService: BusinessService) {}

  /**
   * Retourne la taxonomie commerciale complète (Secteurs, Activités et Modules disponibles).
   * Accessible publiquement pour permettre l'initialisation des interfaces Web et Desktop.
   */
  @Public()
  @Get("taxonomy")
  getTaxonomy() {
    return this.businessService.getTaxonomy();
  }

  /**
   * Retourne le profil, les activités, les modules et les membres de l'entreprise active.
   */
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  @Get("profile")
  async getProfile(@CurrentTenant() tenant: Tenant) {
    return this.businessService.getBusinessProfile(tenant.businessId);
  }

  /**
   * Met à jour les informations générales de l'entreprise active.
   */
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  @Patch("profile")
  async updateProfile(
    @CurrentTenant() tenant: Tenant,
    @Body() dto: UpdateBusinessProfileDto,
  ) {
    return this.businessService.updateBusinessProfile(tenant.businessId, dto);
  }

  /**
   * Met à jour les activités commerciales de l'entreprise.
   * Conserve strictement toutes les données historiques (aucun effacement).
   */
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  @Put("activities")
  @HttpCode(HttpStatus.OK)
  async updateActivities(
    @CurrentTenant() tenant: Tenant,
    @Body() dto: UpdateActivitiesDto,
  ) {
    return this.businessService.updateBusinessActivities(tenant.businessId, dto.activities);
  }

  /**
   * Active ou désactive les modules fonctionnels de l'entreprise (IMEI, Garanties, Unités, etc.).
   */
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  @Put("modules")
  @HttpCode(HttpStatus.OK)
  async updateModules(
    @CurrentTenant() tenant: Tenant,
    @Body() dto: UpdateModulesDto,
  ) {
    return this.businessService.updateBusinessModules(tenant.businessId, dto.modules);
  }

  /**
   * Liste les numéros de série et IMEI pour l'entreprise active (optionnellement filtré par variante).
   */
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  @Get("serials")
  async listSerials(
    @CurrentTenant() tenant: Tenant,
    @Query("variantId") variantId?: string,
  ) {
    return this.businessService.getDeviceSerials(tenant.businessId, variantId);
  }

  /**
   * Enregistre un nouveau numéro de série ou IMEI dans l'inventaire.
   */
  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Post("serials")
  @HttpCode(HttpStatus.CREATED)
  async registerSerial(
    @CurrentTenant() tenant: Tenant,
    @Body() dto: RegisterDeviceSerialDto,
  ) {
    return this.businessService.registerDeviceSerial(tenant.businessId, dto);
  }
}
