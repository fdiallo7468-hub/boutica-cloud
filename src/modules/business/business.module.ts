import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database/database.module";
import { BusinessController } from "./business.controller";
import { BusinessService } from "./business.service";

@Module({
  imports: [DatabaseModule],
  controllers: [BusinessController],
  providers: [BusinessService],
  exports: [BusinessService],
})
export class BusinessModule {}
