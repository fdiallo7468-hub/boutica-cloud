import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database/database.module";
import { OnboardingController } from "./onboarding.controller";

@Module({
  imports: [DatabaseModule],
  controllers: [OnboardingController],
  exports: [],
})
export class AuthExtensionModule {}
