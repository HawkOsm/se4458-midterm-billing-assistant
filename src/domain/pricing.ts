// Billing rules from Mobile_Provider_Billing_Guide.md §2–4, in integer cents.
// Used to explain a stored bill (Query Bill Detailed) and, later, to calculate one.

export const PHONE_INCLUDED_MINUTES = 1000; // §2.1
export const PHONE_BLOCK_MINUTES = 1000; // §2.2
export const PHONE_BLOCK_CENTS = 1000; // $10 per started block

export const INTERNET_BASE_CENTS = 5000; // §3.1: $50, charged even with zero usage
export const INTERNET_INCLUDED_MB = 20_000; // 20 GB, with 1 GB = 1,000 MB (§3.3)
export const INTERNET_BLOCK_MB = 10_000; // §3.2: 10 GB blocks
export const INTERNET_BLOCK_CENTS = 1000; // $10 per started block

export const MB_PER_GB = 1000;

// Integer ceiling division: a partly used block counts as a full block (§2.2, §3.2).
function startedBlocks(used: number, included: number, blockSize: number): number {
  const extra = Math.max(0, used - included);
  return Math.ceil(extra / blockSize);
}

export function phoneExtraBlocks(minutes: number): number {
  return startedBlocks(minutes, PHONE_INCLUDED_MINUTES, PHONE_BLOCK_MINUTES);
}

export function internetExtraBlocks(mb: number): number {
  return startedBlocks(mb, INTERNET_INCLUDED_MB, INTERNET_BLOCK_MB);
}

export function phoneChargeCents(minutes: number): number {
  return phoneExtraBlocks(minutes) * PHONE_BLOCK_CENTS;
}

export function internetChargeCents(mb: number): number {
  return INTERNET_BASE_CENTS + internetExtraBlocks(mb) * INTERNET_BLOCK_CENTS;
}
