// Pay Bill business logic. Calls the DB contexts; knows nothing about HTTP.
// Simulated payments only: no card processing (assignment).
import * as billDbContext from "../db/billDbContext";
import { withTransaction, type Db } from "../db/db";
import * as paymentDbContext from "../db/paymentDbContext";
import * as subscriberDbContext from "../db/subscriberDbContext";
import { formatCents } from "../domain/money";
import { Payment, statusAfterPayment } from "../domain/payment";
import { isPeriodOver } from "../domain/period";

export interface PaymentRequest {
  subscriberNo: string;
  year: number;
  month: number;
  transactionId: string;
  amountCents: number;
}

// What Pay Bill can end in. The controller maps each to an HTTP status.
export type PayResult =
  | { kind: "paid"; payment: Payment; replayed: boolean }
  | { kind: "transactionConflict" } // transactionId already used for another payment
  | { kind: "noSubscriber" }
  | { kind: "noBill" } // calculate the bill first (rule 5)
  | { kind: "monthNotOver" } // paying would lock a month that still gets usage
  | { kind: "unbilledUsage" } // usage added after calculation: recalculate first
  | { kind: "alreadyPaid" }
  | { kind: "exceedsBalance"; remainingCents: number };

function samePayment(payment: Payment, request: PaymentRequest): boolean {
  return (
    payment.subscriberNo === request.subscriberNo &&
    payment.year === request.year &&
    payment.month === request.month &&
    payment.amountCents === request.amountCents
  );
}

function replayOrConflict(existing: Payment, request: PaymentRequest): PayResult {
  return samePayment(existing, request)
    ? { kind: "paid", payment: existing, replayed: true }
    : { kind: "transactionConflict" };
}

export class PaymentService {
  constructor(private readonly db: Db) {}

  async pay(request: PaymentRequest, now = new Date()): Promise<PayResult> {
    return withTransaction(this.db, async (tx): Promise<PayResult> => {
      const subscriberId = await subscriberDbContext.findSubscriberId(tx, request.subscriberNo);
      if (subscriberId === null) return { kind: "noSubscriber" };

      // 1. A retried transactionId gets its original answer, whatever happened since
      //    (decision 5; guide §5.3: retries must not create duplicate payments).
      const existing = await paymentDbContext.findByTransactionId(tx, request.transactionId);
      if (existing) return replayOrConflict(existing, request);

      // A payment locks the month (decision 2): paying an unfinished month would refuse all
      // of its remaining usage, so only finished months can be paid (guide §6.1: due after
      // the month ends). Checked after the replay, so a retry still gets its answer.
      if (!isPeriodOver(request.year, request.month, now)) return { kind: "monthNotOver" };

      // 2. Lock the bill: concurrent payments queue here and each sees the latest balance.
      const bill = await billDbContext.lockBillForUpdate(tx, subscriberId, request.year, request.month);
      if (!bill) return { kind: "noBill" };

      // 3. Paying locks the month (decision 2). Usage added after the calculation would
      //    then never be billed, so the bill must be recalculated first.
      if (await billDbContext.hasUnbilledUsage(tx, subscriberId, request.year, request.month)) {
        return { kind: "unbilledUsage" };
      }

      // 4. Preserve the balance: never pay more than what is left (assignment, rule 2).
      if (bill.remainingCents === 0) return { kind: "alreadyPaid" };
      if (request.amountCents > bill.remainingCents) {
        return { kind: "exceedsBalance", remainingCents: bill.remainingCents };
      }

      const paidCents = bill.paidCents + request.amountCents;
      const status = statusAfterPayment(paidCents, bill.totalCents);
      const snapshot = {
        billId: bill.id,
        transactionId: request.transactionId,
        amount: formatCents(request.amountCents),
        paidAfter: formatCents(paidCents),
        remainingAfter: formatCents(bill.totalCents - paidCents),
        statusAfter: status,
      };

      // 5. Record the payment BEFORE changing the bill: if a concurrent request with the
      //    same transactionId got there first, nothing has been changed yet.
      if (!(await paymentDbContext.insertPayment(tx, snapshot))) {
        const winner = await paymentDbContext.findByTransactionId(tx, request.transactionId);
        if (!winner) throw new Error("payment vanished after a transactionId conflict");
        return replayOrConflict(winner, request);
      }
      await billDbContext.applyPayment(tx, bill.id, snapshot.paidAfter, status);

      const payment = new Payment(
        request.transactionId,
        request.subscriberNo,
        request.year,
        request.month,
        request.amountCents,
        paidCents,
        bill.totalCents - paidCents,
        status,
      );
      return { kind: "paid", payment, replayed: false };
    });
  }
}
