// Domain entity for billing.bills (like the teacher's domain/Todo.js).
import { toCents } from "./money";

export const BILL_STATUSES = ["UNPAID", "PARTIALLY_PAID", "PAID"] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

// A row exactly as `pg` returns it: BIGINT and NUMERIC come back as strings.
export interface BillRow {
  id: string;
  subscriber_id: string;
  period_year: number;
  period_month: number;
  phone_minutes: number;
  internet_mb: number;
  phone_charge: string;
  internet_charge: string;
  total: string;
  paid_amount: string;
  status: BillStatus;
  calculated_at: Date;
}

export class Bill {
  constructor(
    readonly id: number,
    readonly subscriberId: number,
    readonly year: number,
    readonly month: number,
    readonly phoneMinutes: number,
    readonly internetMb: number,
    readonly phoneChargeCents: number,
    readonly internetChargeCents: number,
    readonly totalCents: number,
    readonly paidCents: number,
    readonly status: BillStatus,
    readonly calculatedAt: Date,
  ) {}

  static fromRow(row: BillRow): Bill {
    return new Bill(
      Number(row.id),
      Number(row.subscriber_id),
      row.period_year,
      row.period_month,
      row.phone_minutes,
      row.internet_mb,
      toCents(row.phone_charge),
      toCents(row.internet_charge),
      toCents(row.total),
      toCents(row.paid_amount),
      row.status,
      row.calculated_at,
    );
  }

  get remainingCents(): number {
    return this.totalCents - this.paidCents;
  }
}
