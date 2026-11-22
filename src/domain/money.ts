// Money is handled as integer cents in code, so arithmetic is exact (0.1 + 0.2 problem).
// PostgreSQL NUMERIC(10,2) arrives from `pg` as a string such as "75.00" and goes back
// the same way; these two functions are the only place that converts.

const MONEY_TEXT = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

export function toCents(text: string): number {
  const match = MONEY_TEXT.exec(text);
  if (!match) throw new Error(`Not a money value: "${text}"`);
  const [, sign, whole = "0", fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return sign === "-" ? -cents : cents;
}

export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`Not a cent amount: ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
