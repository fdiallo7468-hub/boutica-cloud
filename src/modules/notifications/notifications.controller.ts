import { Body, Controller, Delete, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { PushDeviceDto } from './dto/push-device.dto';
import { RemovePushDeviceDto } from './dto/remove-push-device.dto';
import { PushNotificationsService } from './push-notifications.service';

@ApiTags('notifications')
@Controller('api/v1/notifications/devices')
export class NotificationsController {
  constructor(private readonly pushNotifications: PushNotificationsService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async register(@CurrentTenant() tenant: Tenant, @Body() input: PushDeviceDto): Promise<void> {
    await this.pushNotifications.registerDevice(tenant, input);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentTenant() tenant: Tenant,
    @Body() input: RemovePushDeviceDto,
  ): Promise<void> {
    await this.pushNotifications.removeDevice(tenant, input.token);
  }
}
