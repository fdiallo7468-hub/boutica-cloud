import { BadRequestException } from '@nestjs/common';

export function accountingAmountToMinorUnits(value: string | number | undefined, field = 'amount'): bigint {
  const raw = value === undefined ? '0' : String(value);
  // Keep the decimal separator escaped once: this regex runs on the original string,
  // before any numeric conversion that could lose monetary precision.
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new BadRequestException(`${field} must be a non-negative decimal with at most 2 decimals`);
  }
  const parts = raw.split('.');
  const whole = parts[0] ?? '0';
  const fraction = parts[1] ?? '';
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
}

export function minorUnitsToAccountingAmount(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

export function isAccountingEntryBalanced(lines: Array<{ debit: bigint; credit: bigint }>): boolean {
  if (lines.length < 2) return false;
  let debit = 0n;
  let credit = 0n;
  for (const line of lines) {
    if (line.debit < 0n || line.credit < 0n || (line.debit > 0n) === (line.credit > 0n)) return false;
    debit += line.debit;
    credit += line.credit;
  }
  return debit > 0n && debit === credit;
}
