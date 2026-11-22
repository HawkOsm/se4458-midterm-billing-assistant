// Bill queries (like the teacher's db/todoDBContext.js): plain SQL in, domain objects out.
// No business rules and no HTTP here. Values are always passed as $1, $2 parameters,
// never pasted into the SQL string, so input can't change the query (SQL injection).
import { Bill, type BillRow } from "../domain/bill";
import type { Db } from "./db";

export async function getBillForPeriod(
  db: Db,
  subscriberNo: string,
  year: number,
  month: number,
): Promise<Bill | null> {
  const { rows } = await db.query<BillRow>(
    `SELECT b.*
       FROM billing.bills b
       JOIN billing.subscribers s ON s.id = b.subscriber_id
      WHERE s.subscriber_no = $1
        AND b.period_year = $2
        AND b.period_month = $3`,
    [subscriberNo, year, month],
  );
  const row = rows[0];
  return row ? Bill.fromRow(row) : null;
}
