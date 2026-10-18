import { Global, Module } from "@nestjs/common";
import { NovuService } from "./novu.service";

@Global()
@Module({
  providers: [NovuService],
  exports: [NovuService],
})
export class NotificationsModule {}
