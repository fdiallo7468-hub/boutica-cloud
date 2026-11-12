import { Module } from '@nestjs/common';
import { ReturnsController } from './returns.controller';
import { CreateReturnUseCase } from './application/create-return.usecase';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { AccountingModule } from '../accounting/accounting.module';

@Module({
  imports: [LoyaltyModule, AccountingModule],
  controllers: [ReturnsController],
  providers: [CreateReturnUseCase],
})
export class ReturnsModule {}
