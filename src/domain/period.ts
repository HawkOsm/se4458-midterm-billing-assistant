// Billing periods are calendar months (guide §4.1), judged in UTC.

// True when the month hasn't started yet. The current, unfinished month is not future:
// it can be billed and recalculated until paid.
export function isFuturePeriod(year: number, month: number, now: Date): boolean {
  const current = now.getUTCFullYear() * 12 + now.getUTCMonth(); // getUTCMonth: 0-11
  return year * 12 + (month - 1) > current;
}

export function formatPeriod(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

// The one message for the future-month rule, used by every endpoint that enforces it.
export function futurePeriodMessage(year: number, month: number, what: string): string {
  return `${formatPeriod(year, month)} has not started yet; ${what} only for past or current months`;
}

// True once the whole month is in the past (UTC). A bill is due after its month ends
// (guide §6.1), and paying locks the month, so only finished months can be paid.
export function isPeriodOver(year: number, month: number, now: Date): boolean {
  const current = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return year * 12 + (month - 1) < current;
}

