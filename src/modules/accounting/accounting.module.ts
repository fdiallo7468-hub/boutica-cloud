import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AccountingController } from './accounting.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [AccountingController],
})
export class AccountingModule {}
