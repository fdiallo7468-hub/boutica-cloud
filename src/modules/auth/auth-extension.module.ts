import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database/database.module";
import { OnboardingController } from "./onboarding.controller";
import { UserBusinessesController } from "./user-businesses.controller";

@Module({
  imports: [DatabaseModule],
  controllers: [
    OnboardingController,
    UserBusinessesController,
  ],
  providers: [],
  exports: [],
})
export class AuthExtensionModule {}
