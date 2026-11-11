import { BadRequestException } from '@nestjs/common';
import {
  accountingAmountToMinorUnits,
  isAccountingEntryBalanced,
  minorUnitsToAccountingAmount,
} from './accounting-money';

describe('SYSCOHADA accounting money helpers', () => {
  it.each([
    ['0', 0n],
    ['12', 1200n],
    ['12.3', 1230n],
    ['12.34', 1234n],
    ['90071992547409.91', 9007199254740991n],
  ])('converts %s to integer minor units', (value, expected) => {
    expect(accountingAmountToMinorUnits(value as string | number)).toBe(expected);
  });

  it.each(['-1', '1.234', '1,25', 'abc', ''])('rejects invalid amount %s', (value) => {
    expect(() => accountingAmountToMinorUnits(value)).toThrow(BadRequestException);
  });

  it('formats positive and negative minor units without floating point', () => {
    expect(minorUnitsToAccountingAmount(123456789012345678n)).toBe('1234567890123456.78');
    expect(minorUnitsToAccountingAmount(-1234n)).toBe('-12.34');
  });

  it('accepts balanced entries with multiple lines', () => {
    expect(isAccountingEntryBalanced([
      { debit: 1250n, credit: 0n },
      { debit: 750n, credit: 0n },
      { debit: 0n, credit: 2000n },
    ])).toBe(true);
  });

  it('rejects unbalanced, empty, one-sided and two-sided lines', () => {
    expect(isAccountingEntryBalanced([{ debit: 100n, credit: 0n }, { debit: 0n, credit: 99n }])).toBe(false);
    expect(isAccountingEntryBalanced([{ debit: 100n, credit: 0n }])).toBe(false);
    expect(isAccountingEntryBalanced([{ debit: 0n, credit: 0n }, { debit: 0n, credit: 0n }])).toBe(false);
    expect(isAccountingEntryBalanced([{ debit: 100n, credit: 100n }, { debit: 0n, credit: 0n }])).toBe(false);
  });
});
