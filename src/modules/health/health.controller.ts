import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '@thallesp/nestjs-better-auth';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Public()
  @Get()
  async check() {
    try {
      await this.db.db.execute(sql`select 1`);
    } catch {
      // A failed database check must produce a non-2xx response so Render and
      // external monitors do not mistake a partially unavailable API for healthy.
      throw new ServiceUnavailableException({
        status: 'error',
        service: 'boutica-backend',
        version: '2.1.0',
        database: 'disconnected',
        timestamp: new Date().toISOString(),
      });
    }

    return {
      status: 'ok',
      service: 'boutica-backend',
      version: '2.1.0',
      database: 'connected',
      timestamp: new Date().toISOString(),
    };
  }
}
