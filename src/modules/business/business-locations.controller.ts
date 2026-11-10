import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentTenant } from "../auth/current-tenant.decorator";
import { Tenant } from "../auth/tenant.type";
import { PermissionGuard } from "../auth/permissions/permission.guard";
import { RequirePermissions } from "../auth/permissions/require-permissions.decorator";
import { PERMISSIONS } from "../auth/permissions/permission-catalog";
import {
  CreateBusinessLocationDto,
  UpdateBusinessLocationDto,
} from "./dto/business-location.dto";
import { BusinessLocationsService } from "./business-locations.service";

@ApiTags("business-locations")
@Controller("api/v1/business/locations")
@UseGuards(PermissionGuard)
export class BusinessLocationsController {
  constructor(private readonly locations: BusinessLocationsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.LOCATIONS_READ)
  list(@CurrentTenant() tenant: Tenant) {
    return this.locations.list(tenant.businessId);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.LOCATIONS_MANAGE)
  create(
    @CurrentTenant() tenant: Tenant,
    @Body() dto: CreateBusinessLocationDto,
  ) {
    return this.locations.create(tenant.businessId, dto);
  }

  @Patch(":locationId")
  @RequirePermissions(PERMISSIONS.LOCATIONS_MANAGE)
  update(
    @CurrentTenant() tenant: Tenant,
    @Param("locationId") locationId: string,
    @Body() dto: UpdateBusinessLocationDto,
  ) {
    return this.locations.update(tenant.businessId, locationId, dto);
  }

  @Post(":locationId/default")
  @RequirePermissions(PERMISSIONS.LOCATIONS_MANAGE)
  setDefault(
    @CurrentTenant() tenant: Tenant,
    @Param("locationId") locationId: string,
  ) {
    return this.locations.setDefault(tenant.businessId, locationId);
  }
}
