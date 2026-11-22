// Payment queries: plain SQL in, domain objects out.
import { Payment, type PaymentRow } from "../domain/payment";
import type { Db } from "./db";

const PAYMENT_WITH_BILL = `
  SELECT p.transaction_id, p.amount, p.paid_amount_after, p.remaining_after, p.status_after,
         s.subscriber_no, b.period_year, b.period_month
    FROM billing.payments p
    JOIN billing.bills b ON b.id = p.bill_id
    JOIN billing.subscribers s ON s.id = b.subscriber_id`;

// transactionId is unique across all payments (uq_payments_transaction_id).
export async function findByTransactionId(db: Db, transactionId: string): Promise<Payment | null> {
  const { rows } = await db.query<PaymentRow>(`${PAYMENT_WITH_BILL} WHERE p.transaction_id = $1`, [transactionId]);
  const row = rows[0];
  return row ? Payment.fromRow(row) : null;
}

// Records the payment with its result snapshot, or nothing if a concurrent request just
// used the same transactionId (the unique key makes it wait, then skip). false = skipped.
export async function insertPayment(
  db: Db,
  payment: { billId: number; transactionId: string; amount: string; paidAfter: string; remainingAfter: string; statusAfter: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO billing.payments (bill_id, transaction_id, amount, paid_amount_after, remaining_after, status_after)
     VALUES ($1, $2, $3::numeric, $4::numeric, $5::numeric, $6)
     ON CONFLICT (transaction_id) DO NOTHING`,
    [payment.billId, payment.transactionId, payment.amount, payment.paidAfter, payment.remainingAfter, payment.statusAfter],
  );
  return rowCount === 1;
}
