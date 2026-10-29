import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database/database.module";
import { DesktopAuthService } from "./desktop-auth.service";
import { OAuthCallbackController } from "./oauth-callback.controller";
import { OnboardingController } from "./onboarding.controller";

@Module({
  imports: [DatabaseModule],
  controllers: [OnboardingController, OAuthCallbackController],
  providers: [DesktopAuthService],
  exports: [DesktopAuthService],
})
export class AuthExtensionModule {}

