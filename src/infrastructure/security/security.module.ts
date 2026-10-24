import { Global, Module } from '@nestjs/common';
import { ArcjetService } from './arcjet.service';
import { ArcjetGuard } from './arcjet.guard';

@Global()
@Module({
  providers: [ArcjetService, ArcjetGuard],
  exports: [ArcjetService, ArcjetGuard],
})
export class SecurityModule {}
