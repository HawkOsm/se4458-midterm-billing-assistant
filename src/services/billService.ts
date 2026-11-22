// Bill business logic (like the teacher's services/todoService.js). Calls the DB context;
// knows nothing about HTTP.
import * as billDbContext from "../db/billDbContext";
import type { Db } from "../db/db";
import type { Bill } from "../domain/bill";

export class BillService {
  constructor(private readonly db: Db) {}

  // The stored bill for a period, or null if it was never calculated.
  // Guide §4.4: Query Bill reports the stored bill; it never calculates one.
  async get(subscriberNo: string, year: number, month: number): Promise<Bill | null> {
    return billDbContext.getBillForPeriod(this.db, subscriberNo, year, month);
  }
}
