// Billing rules (tariffs), in integer cents. Each stored bill records the tariff it was
// calculated with (bills.tariff_id), so an old bill is always explained with the prices
// that produced it, even after a price change adds a new tariff here.

export interface Tariff {
  id: string;
  phoneIncludedMinutes: number;
  phoneBlockMinutes: number;
  phoneBlockCents: number;
  internetBaseCents: number; // charged even with zero usage
  internetIncludedMb: number;
  internetBlockMb: number;
  internetBlockCents: number;
}

// Mobile_Provider_Billing_Guide.md (document MOB-BILLING-2026-01, v1.0), §2–4.
export const MOB_BILLING_2026_01: Tariff = {
  id: "MOB-BILLING-2026-01",
  phoneIncludedMinutes: 1000, // §2.1
  phoneBlockMinutes: 1000, // §2.2
  phoneBlockCents: 1000, // §2.2: $10 per started block
  internetBaseCents: 5000, // §3.1: $50, even with zero usage
  internetIncludedMb: 20_000, // §3.1: 20 GB, with 1 GB = 1,000 MB (§3.3)
  internetBlockMb: 10_000, // §3.2: 10 GB blocks
  internetBlockCents: 1000, // §3.2: $10 per started block
};

// The tariff new calculations use. A price change adds a tariff and points this at it.
export const CURRENT_TARIFF = MOB_BILLING_2026_01;

const TARIFFS = new Map<string, Tariff>([[MOB_BILLING_2026_01.id, MOB_BILLING_2026_01]]);

export function getTariff(id: string): Tariff {
  const tariff = TARIFFS.get(id);
  if (!tariff) throw new Error(`Unknown tariff: ${id}`);
  return tariff;
}

export const MB_PER_GB = 1000; // guide §3.3 (a unit definition, not a price)

// Integer ceiling division: a partly used block counts as a full block (§2.2, §3.2).
function startedBlocks(used: number, included: number, blockSize: number): number {
  const extra = Math.max(0, used - included);
  return Math.ceil(extra / blockSize);
}

export function phoneExtraBlocks(minutes: number, tariff: Tariff = CURRENT_TARIFF): number {
  return startedBlocks(minutes, tariff.phoneIncludedMinutes, tariff.phoneBlockMinutes);
}

export function internetExtraBlocks(mb: number, tariff: Tariff = CURRENT_TARIFF): number {
  return startedBlocks(mb, tariff.internetIncludedMb, tariff.internetBlockMb);
}

export function phoneChargeCents(minutes: number, tariff: Tariff = CURRENT_TARIFF): number {
  return phoneExtraBlocks(minutes, tariff) * tariff.phoneBlockCents;
}

export function internetChargeCents(mb: number, tariff: Tariff = CURRENT_TARIFF): number {
  return tariff.internetBaseCents + internetExtraBlocks(mb, tariff) * tariff.internetBlockCents;
}
