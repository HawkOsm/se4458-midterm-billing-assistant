// Bill business logic (like the teacher's services/todoService.js). Calls the DB contexts;
// knows nothing about HTTP.
import * as billDbContext from "../db/billDbContext";
import type { Db } from "../db/db";
import * as usageEventDbContext from "../db/usageEventDbContext";
import type { Bill } from "../domain/bill";
import type { Page, UsageEvent } from "../domain/usageEvent";

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
  async getDetails(
    subscriberNo: string,
    year: number,
    month: number,
    offset: number,
    limit: number,
  ): Promise<BillDetails | null> {
    const bill = await this.get(subscriberNo, year, month);
    if (!bill) return null;
    const events = await usageEventDbContext.getEventsForBill(this.db, bill.id, offset, limit);
    return { bill, events };
  }
}
