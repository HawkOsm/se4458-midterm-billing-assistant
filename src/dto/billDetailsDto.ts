// Query Bill Detailed request/response shapes.
import type { Bill } from "../domain/bill";
import { formatCents } from "../domain/money";
import {
  INTERNET_BASE_CENTS,
  INTERNET_BLOCK_CENTS,
  INTERNET_BLOCK_MB,
  INTERNET_INCLUDED_MB,
  MB_PER_GB,
  PHONE_BLOCK_CENTS,
  PHONE_BLOCK_MINUTES,
  PHONE_INCLUDED_MINUTES,
  internetExtraBlocks,
  phoneExtraBlocks,
} from "../domain/pricing";
import { USAGE_TYPES, type Page, type UsageEvent } from "../domain/usageEvent";
import { toBillDto } from "./billDto";
import { z } from "./zod";

export const MAX_PAGE_SIZE = 100;

// Offset pagination (course slides 40–42): the client picks the page size and where to
// start; the next page is offset + limit. Over-large limits are refused, not clamped.
export const PageQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0).openapi({ example: 0 }),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20).openapi({ example: 20 }),
});
export type PageQuery = z.infer<typeof PageQuery>;

const Money = z.string().regex(/^-?\d+\.\d{2}$/);

const UsageEventDto = z
  .object({
    type: z.enum(USAGE_TYPES).openapi({ example: "PHONE" }),
    amount: z.number().int().openapi({ example: 10 }),
    unit: z.enum(["minutes", "MB"]).openapi({ example: "minutes" }),
    recordedAt: z.string().openapi({ example: "2025-04-12T09:30:00.000Z" }),
  })
  .openapi("UsageEvent");

export const BillDetailsDto = z
  .object({
    subscriberNo: z.string().openapi({ example: "5551234" }),
    year: z.number().int().openapi({ example: 2025 }),
    month: z.number().int().openapi({ example: 4 }),
    total: Money.openapi({ example: "80.00" }),
    paidAmount: Money.openapi({ example: "0.00" }),
    remainingBalance: Money.openapi({ example: "80.00" }),
    status: z.enum(["UNPAID", "PARTIALLY_PAID", "PAID"]),
    calculatedAt: z.string().openapi({ example: "2025-05-01T00:00:00.000Z" }),
    usage: z.object({
      phoneMinutes: z.number().int().openapi({ example: 1350 }),
      internetMb: z.number().int().openapi({ example: 35000 }),
      internetGb: z.number().openapi({ description: "internetMb / 1000 (guide §3.3)", example: 35 }),
    }),
    charges: z.object({
      phone: z.object({
        includedMinutes: z.number().int().openapi({ example: 1000 }),
        extraBlocks: z.number().int().openapi({ description: "Started 1,000-minute blocks above the free minutes", example: 1 }),
        blockMinutes: z.number().int().openapi({ example: 1000 }),
        blockPrice: Money.openapi({ example: "10.00" }),
        charge: Money.openapi({ example: "10.00" }),
      }),
      internet: z.object({
        baseCharge: Money.openapi({ description: "Monthly price, charged even with zero usage", example: "50.00" }),
        includedGb: z.number().int().openapi({ example: 20 }),
        extraBlocks: z.number().int().openapi({ description: "Started 10 GB blocks above 20 GB", example: 2 }),
        blockGb: z.number().int().openapi({ example: 10 }),
        blockPrice: Money.openapi({ example: "10.00" }),
        charge: Money.openapi({ example: "70.00" }),
      }),
    }),
    usageEvents: z.object({
      items: z.array(UsageEventDto),
      offset: z.number().int().openapi({ example: 0 }),
      limit: z.number().int().openapi({ example: 20 }),
      total: z.number().int().openapi({ description: "All events counted in this bill", example: 3635 }),
    }),
  })
  .openapi("BillDetails");
export type BillDetailsDto = z.infer<typeof BillDetailsDto>;

// The stored charges are the truth (guide §4.4); block counts are derived from the stored
// usage with the same pricing rules, so the agent can explain *why* a charge is what it is.
export function toBillDetailsDto(bill: Bill, subscriberNo: string, events: Page<UsageEvent>): BillDetailsDto {
  return {
    ...toBillDto(bill, subscriberNo),
    calculatedAt: bill.calculatedAt.toISOString(),
    usage: {
      phoneMinutes: bill.phoneMinutes,
      internetMb: bill.internetMb,
      internetGb: bill.internetMb / MB_PER_GB,
    },
    charges: {
      phone: {
        includedMinutes: PHONE_INCLUDED_MINUTES,
        extraBlocks: phoneExtraBlocks(bill.phoneMinutes),
        blockMinutes: PHONE_BLOCK_MINUTES,
        blockPrice: formatCents(PHONE_BLOCK_CENTS),
        charge: formatCents(bill.phoneChargeCents),
      },
      internet: {
        baseCharge: formatCents(INTERNET_BASE_CENTS),
        includedGb: INTERNET_INCLUDED_MB / MB_PER_GB,
        extraBlocks: internetExtraBlocks(bill.internetMb),
        blockGb: INTERNET_BLOCK_MB / MB_PER_GB,
        blockPrice: formatCents(INTERNET_BLOCK_CENTS),
        charge: formatCents(bill.internetChargeCents),
      },
    },
    usageEvents: {
      items: events.items.map((e) => ({
        type: e.type,
        amount: e.amount,
        unit: e.unit,
        recordedAt: e.recordedAt.toISOString(),
      })),
      offset: events.offset,
      limit: events.limit,
      total: events.total,
    },
  };
}
