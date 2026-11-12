import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database/database.module";
import { BusinessController } from "./business.controller";
import { BusinessService } from "./business.service";
import { BusinessLocationsController } from "./business-locations.controller";
import { BusinessLocationsService } from "./business-locations.service";

@Module({
  imports: [DatabaseModule],
  controllers: [BusinessController, BusinessLocationsController],
  providers: [BusinessService, BusinessLocationsService],
  exports: [BusinessService, BusinessLocationsService],
})
export class BusinessModule {}
