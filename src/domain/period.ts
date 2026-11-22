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
