import { Module } from '@nestjs/common';
import { ExpensesController } from './expenses.controller';
import { AccountingModule } from '../accounting/accounting.module';

@Module({ imports: [AccountingModule], controllers: [ExpensesController] })
export class ExpensesModule {}
