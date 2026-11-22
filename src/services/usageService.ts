// Add Usage business logic. Calls the DB contexts; knows nothing about HTTP.
import * as billDbContext from "../db/billDbContext";
import { withTransaction, type Db } from "../db/db";
import * as subscriberDbContext from "../db/subscriberDbContext";
import * as usageEventDbContext from "../db/usageEventDbContext";
import { isFuturePeriod } from "../domain/period";
import { UNIT_AMOUNT, type RecordedUsage, type UsageType } from "../domain/usageEvent";

export interface UsageReport {
  year: number;
  month: number;
  usageType: UsageType;
  quantity: number;
}

// What Add Usage can end in. The controller maps each to an HTTP status.
export type AddUsageResult =
  | { kind: "recorded"; record: RecordedUsage; replayed: boolean }
  | { kind: "keyConflict" } // key already used for a different report
  | { kind: "locked" } // the period's bill has payments (rule 4)
  | { kind: "noSubscriber" }
  | { kind: "futurePeriod" };

// A retry must describe exactly the same report as the original to be replayed.
function sameReport(record: RecordedUsage, report: UsageReport): boolean {
  return (
    record.year === report.year &&
    record.month === report.month &&
    record.event.type === report.usageType &&
    record.quantity === report.quantity
  );
}

function replayOrConflict(existing: RecordedUsage, report: UsageReport): AddUsageResult {
  return sameReport(existing, report)
    ? { kind: "recorded", record: existing, replayed: true }
    : { kind: "keyConflict" };
}

export class UsageService {
  constructor(private readonly db: Db) {}

  // Records `quantity` units of usage (10 minutes or 1 MB each, guide §2.3, §3.3) as one
  // event. Idempotent per key (decision 4): a retry replays the original, records nothing.
  async add(subscriberNo: string, report: UsageReport, key: string, now = new Date()): Promise<AddUsageResult> {
    return withTransaction(this.db, async (tx): Promise<AddUsageResult> => {
      const subscriberId = await subscriberDbContext.findSubscriberId(tx, subscriberNo);
      if (subscriberId === null) return { kind: "noSubscriber" };

      // A retry gets its original answer, whatever changed since: checked before the
      // future-month rule (another server's clock may differ at a month boundary) and
      // before the lock (the bill may have been paid in between).
      const existing = await usageEventDbContext.findByIdempotencyKey(tx, subscriberId, key);
      if (existing) return replayOrConflict(existing, report);

      if (isFuturePeriod(report.year, report.month, now)) return { kind: "futurePeriod" };

      const bill = await billDbContext.lockBillForShare(tx, subscriberId, report.year, report.month);
      if (bill?.hasPayments) return { kind: "locked" };

      const inserted = await usageEventDbContext.insertUsageEvent(tx, {
        subscriberId,
        year: report.year,
        month: report.month,
        type: report.usageType,
        amount: report.quantity * UNIT_AMOUNT[report.usageType],
        key,
      });
      if (inserted) return { kind: "recorded", record: inserted, replayed: false };

      // A concurrent request with the same key won the insert; answer as its retry.
      const winner = await usageEventDbContext.findByIdempotencyKey(tx, subscriberId, key);
      if (!winner) throw new Error("usage event vanished after an idempotency-key conflict");
      return replayOrConflict(winner, report);
    });
  }
}
