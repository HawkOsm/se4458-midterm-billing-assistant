// Bill business logic (like the teacher's services/todoService.js). Calls the DB contexts;
// knows nothing about HTTP.
import * as billDbContext from "../db/billDbContext";
import { withTransaction, type Db } from "../db/db";
import * as subscriberDbContext from "../db/subscriberDbContext";
import * as usageEventDbContext from "../db/usageEventDbContext";
import type { Bill } from "../domain/bill";
import { formatCents } from "../domain/money";
import { isFuturePeriod } from "../domain/period";
import { CURRENT_TARIFF, internetChargeCents, phoneChargeCents } from "../domain/pricing";
import type { Page, UsageEvent } from "../domain/usageEvent";

// What Calculate Bill can end in. The controller maps each to an HTTP status.
export type CalculateResult =
  | { kind: "created" | "recalculated"; bill: Bill }
  | { kind: "locked" } // the bill has payments (decision 2)
  | { kind: "noSubscriber" }
  | { kind: "futurePeriod" };

export interface BillDetails {
  bill: Bill;
  events: Page<UsageEvent>;
}

export class BillService {
  constructor(private readonly db: Db) {}

  // The stored bill for a period, or null if it was never calculated.
  // Guide §4.4: Query Bill reports the stored bill; it never calculates one.
  async get(subscriberNo: string, year: number, month: number): Promise<Bill | null> {
    return billDbContext.getBillForPeriod(this.db, subscriberNo, year, month);
  }

  // The stored bill plus one page of the usage events it was calculated from.
  // Both reads run in one REPEATABLE READ transaction, so a recalculation in between
  // can't pair the old bill with the new event list.
  async getDetails(
    subscriberNo: string,
    year: number,
    month: number,
    offset: number,
    limit: number,
  ): Promise<BillDetails | null> {
    return withTransaction(
      this.db,
      async (tx) => {
        const bill = await billDbContext.getBillForPeriod(tx, subscriberNo, year, month);
        if (!bill) return null;
        const events = await usageEventDbContext.getEventsForBill(tx, bill.id, offset, limit);
        return { bill, events };
      },
      { isolation: "REPEATABLE READ", readOnly: true },
    );
  }

  // Calculates and stores the period's bill from its usage (guide §4.2, §4.4). Safe to
  // repeat: one bill per subscriber and month, updated in place until its first payment.
  // Everything happens in one transaction, so a failure leaves no half-calculated bill
  // and no events linked to a bill that wasn't saved.
  async calculate(subscriberNo: string, year: number, month: number, now = new Date()): Promise<CalculateResult> {
    if (isFuturePeriod(year, month, now)) return { kind: "futurePeriod" };

    return withTransaction(this.db, async (tx): Promise<CalculateResult> => {
      const subscriberId = await subscriberDbContext.findSubscriberId(tx, subscriberNo);
      if (subscriberId === null) return { kind: "noSubscriber" };

      const claim = await billDbContext.claimBillForCalculation(tx, subscriberId, year, month);
      if (!claim) return { kind: "locked" };

      await billDbContext.linkUnbilledEvents(tx, claim.billId, subscriberId, year, month);
      const usage = await billDbContext.sumBilledUsage(tx, claim.billId);

      const phoneCents = phoneChargeCents(usage.phoneMinutes, CURRENT_TARIFF);
      const internetCents = internetChargeCents(usage.internetMb, CURRENT_TARIFF);
      const bill = await billDbContext.saveCalculatedBill(tx, claim.billId, {
        ...usage,
        phoneCharge: formatCents(phoneCents),
        internetCharge: formatCents(internetCents),
        total: formatCents(phoneCents + internetCents),
        tariffId: CURRENT_TARIFF.id,
      });
      return { kind: claim.inserted ? "created" : "recalculated", bill };
    });
  }
}
