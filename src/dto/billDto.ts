// Bill request/response shapes (like the teacher's dto/TodoDto.js). The same zod schema
// validates the request and generates the Swagger document.
import { BILL_STATUSES, type Bill } from "../domain/bill";
import { formatCents } from "../domain/money";
import { isPeriodOver } from "../domain/period";
import { z } from "./zod";

// The subscriber number in every path (billing.subscribers.subscriber_no VARCHAR(20)).
export const SubscriberNo = z.string().min(1).max(20).openapi({ example: "5551234" });

export const BillPeriodParams = z.object({
  subscriberNo: SubscriberNo,
  year: z.coerce.number().int().min(2000).max(2100).openapi({ example: 2025 }),
  month: z.coerce.number().int().min(1).max(12).openapi({ example: 4 }),
});
export type BillPeriodParams = z.infer<typeof BillPeriodParams>;

// Money is a string ("75.00") so no client parses it into a lossy float.
export const Money = z.string().regex(/^-?\d+\.\d{2}$/);

export const BillDto = z
  .object({
    subscriberNo: z.string().openapi({ example: "5551234" }),
    year: z.number().int().openapi({ example: 2025 }),
    month: z.number().int().openapi({ example: 4 }),
    total: Money.openapi({ example: "75.00" }),
    paidAmount: Money.openapi({ example: "25.00" }),
    remainingBalance: Money.openapi({ example: "50.00" }),
    status: z.enum(BILL_STATUSES).openapi({ example: "PARTIALLY_PAID" }),
    estimate: z.boolean().openapi({
      description:
        "true while the billing month is still running: the total so far, which will change and " +
        "can't be paid yet. Don't present it as the month's bill (guide §4.4).",
      example: false,
    }),
  })
  .openapi("Bill");
export type BillDto = z.infer<typeof BillDto>;

// `estimate` is worked out when the response is built, not stored, so it turns false on
// its own once the month is over (UTC, like every other period rule).
export function toBillDto(bill: Bill, subscriberNo: string, now = new Date()): BillDto {
  return {
    subscriberNo,
    year: bill.year,
    month: bill.month,
    total: formatCents(bill.totalCents),
    paidAmount: formatCents(bill.paidCents),
    remainingBalance: formatCents(bill.remainingCents),
    status: bill.status,
    estimate: !isPeriodOver(bill.year, bill.month, now),
  };
}
