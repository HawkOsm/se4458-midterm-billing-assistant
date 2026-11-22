// Pay Bill request/response shapes.
import { BILL_STATUSES } from "../domain/bill";
import { formatCents, toCents } from "../domain/money";
import type { Payment } from "../domain/payment";
import { Money } from "./billDto";
import { DtoError } from "./dtoError";
import { z } from "./zod";

export const PayBillRequest = z
  .object({
    // Matches billing.payments.transaction_id VARCHAR(100), unique across all payments.
    transactionId: z
      .string()
      .min(1)
      .max(100)
      .openapi({ description: "Unique per payment; a retry reuses it", example: "pay-2025-04-0001" }),
    // "25.50" or 25.5: a positive amount with at most 2 decimals.
    amount: z.union([z.string(), z.number()]).openapi({ example: "25.50" }),
  })
  .openapi("PayBillRequest");
export type PayBillRequest = z.infer<typeof PayBillRequest>;

const AMOUNT_TEXT = /^\d+(\.\d{1,2})?$/;

// Strings and numbers are checked as text, so 0.1 + 0.2 (0.30000000000000004) is refused
// instead of being rounded silently.
export function parseAmountCents(amount: string | number): number {
  const text = typeof amount === "number" ? String(amount) : amount.trim();
  if (!AMOUNT_TEXT.test(text)) throw new DtoError("amount: must be a positive amount with at most 2 decimals", 400);
  const cents = toCents(text);
  if (cents <= 0) throw new DtoError("amount: must be greater than 0", 400);
  return cents;
}

export const PaymentDto = z
  .object({
    paymentStatus: z.literal("ACCEPTED").openapi({ description: "Simulated payment, no real money moved" }),
    transactionId: z.string().openapi({ example: "pay-2025-04-0001" }),
    subscriberNo: z.string().openapi({ example: "5551234" }),
    year: z.number().int().openapi({ example: 2025 }),
    month: z.number().int().openapi({ example: 4 }),
    amount: Money.openapi({ example: "25.00" }),
    paidAmount: Money.openapi({ description: "Paid on this bill after this payment", example: "25.00" }),
    remainingBalance: Money.openapi({ example: "55.00" }),
    billStatus: z.enum(BILL_STATUSES).openapi({ example: "PARTIALLY_PAID" }),
  })
  .openapi("Payment");
export type PaymentDto = z.infer<typeof PaymentDto>;

export function toPaymentDto(payment: Payment): PaymentDto {
  return {
    paymentStatus: "ACCEPTED",
    transactionId: payment.transactionId,
    subscriberNo: payment.subscriberNo,
    year: payment.year,
    month: payment.month,
    amount: formatCents(payment.amountCents),
    paidAmount: formatCents(payment.paidAfterCents),
    remainingBalance: formatCents(payment.remainingAfterCents),
    billStatus: payment.statusAfter,
  };
}
