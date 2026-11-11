import { Module } from '@nestjs/common';
import { ReturnsController } from './returns.controller';
import { CreateReturnUseCase } from './application/create-return.usecase';
import { LoyaltyModule } from '../loyalty/loyalty.module';

@Module({
  imports: [LoyaltyModule],
  controllers: [ReturnsController],
  providers: [CreateReturnUseCase],
})
export class ReturnsModule {}
