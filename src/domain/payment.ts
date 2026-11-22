// Domain entity for billing.payments: one row per accepted Pay Bill call.
import type { BillStatus } from "./bill";
import { toCents } from "./money";

// A payment row joined with the bill and subscriber it belongs to (what a retried
// transactionId is compared against, and what its replay answers with).
export interface PaymentRow {
  transaction_id: string;
  amount: string;
  paid_amount_after: string;
  remaining_after: string;
  status_after: BillStatus;
  subscriber_no: string;
  period_year: number;
  period_month: number;
}

export class Payment {
  constructor(
    readonly transactionId: string,
    readonly subscriberNo: string,
    readonly year: number,
    readonly month: number,
    readonly amountCents: number,
    // Snapshot of the bill right after this payment, so a retry replays the same answer
    // even if more payments happened since (decision 5).
    readonly paidAfterCents: number,
    readonly remainingAfterCents: number,
    readonly statusAfter: BillStatus,
  ) {}

  static fromRow(row: PaymentRow): Payment {
    return new Payment(
      row.transaction_id,
      row.subscriber_no,
      row.period_year,
      row.period_month,
      toCents(row.amount),
      toCents(row.paid_amount_after),
      toCents(row.remaining_after),
      row.status_after,
    );
  }
}

// Guide §5.1: a partial payment does not mark the bill paid; only a zero balance does.
export function statusAfterPayment(paidCents: number, totalCents: number): BillStatus {
  if (paidCents >= totalCents) return "PAID";
  return paidCents > 0 ? "PARTIALLY_PAID" : "UNPAID";
}
