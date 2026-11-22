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

// ---------- Calculate Bill (each step runs inside the caller's transaction) ----------

// Creates the period's bill row (all zeros) or takes the existing one, and locks it
// until the transaction ends, so concurrent calculations of the same month queue up.
// ON CONFLICT ... WHERE paid_amount = 0: a bill with payments is locked (decision 2), so
// then no row comes back and the caller reports it.
// `inserted` uses a Postgres detail: a row created by this statement has xmax = 0,
// a row it updated does not.
export async function claimBillForCalculation(
  db: Db,
  subscriberId: number,
  year: number,
  month: number,
): Promise<{ billId: number; inserted: boolean } | null> {
  const { rows } = await db.query<{ id: string; inserted: boolean }>(
    `INSERT INTO billing.bills (subscriber_id, period_year, period_month, phone_minutes,
         internet_mb, phone_charge, internet_charge, total)
     VALUES ($1, $2, $3, 0, 0, 0, 0, 0)
     ON CONFLICT (subscriber_id, period_year, period_month)
       DO UPDATE SET calculated_at = billing.bills.calculated_at
       WHERE billing.bills.paid_amount = 0
     RETURNING id, (xmax = 0) AS inserted`,
    [subscriberId, year, month],
  );
  const row = rows[0];
  return row ? { billId: Number(row.id), inserted: row.inserted } : null;
}

// Marks the period's not-yet-billed usage events as counted in this bill (decision 9).
// Events still being written by an uncommitted Add Usage aren't visible here, so they
// stay unbilled and are picked up by the next calculation, never half-counted.
export async function linkUnbilledEvents(
  db: Db,
  billId: number,
  subscriberId: number,
  year: number,
  month: number,
): Promise<void> {
  await db.query(
    `UPDATE billing.usage_events
        SET bill_id = $1
      WHERE subscriber_id = $2 AND period_year = $3 AND period_month = $4
        AND bill_id IS NULL`,
    [billId, subscriberId, year, month],
  );
}

export async function sumBilledUsage(
  db: Db,
  billId: number,
): Promise<{ phoneMinutes: number; internetMb: number }> {
  const { rows } = await db.query<{ phone: string; internet: string }>(
    `SELECT coalesce(sum(amount) FILTER (WHERE usage_type = 'PHONE'), 0) AS phone,
            coalesce(sum(amount) FILTER (WHERE usage_type = 'INTERNET'), 0) AS internet
       FROM billing.usage_events
      WHERE bill_id = $1`,
    [billId],
  );
  return { phoneMinutes: Number(rows[0]?.phone ?? 0), internetMb: Number(rows[0]?.internet ?? 0) };
}

export interface CalculatedAmounts {
  phoneMinutes: number;
  internetMb: number;
  phoneCharge: string; // "10.00": money goes to NUMERIC as exact text
  internetCharge: string;
  total: string;
  tariffId: string;
}

// Stores the result. The issue date (calculated_at, which starts the dispute window,
// guide §7.1) only moves when the bill actually changed, so recalculating with no new
// usage leaves the bill exactly as it was.
export async function saveCalculatedBill(db: Db, billId: number, amounts: CalculatedAmounts): Promise<Bill> {
  const { rows } = await db.query<BillRow>(
    `UPDATE billing.bills
        SET calculated_at = CASE
              WHEN (phone_minutes, internet_mb, phone_charge, internet_charge, tariff_id)
                   IS DISTINCT FROM ($2::int, $3::int, $4::numeric, $5::numeric, $7::varchar)
              THEN now() ELSE calculated_at END,
            phone_minutes = $2, internet_mb = $3,
            phone_charge = $4::numeric, internet_charge = $5::numeric, total = $6::numeric,
            tariff_id = $7, status = 'UNPAID'
      WHERE id = $1
      RETURNING *`,
    [
      billId,
      amounts.phoneMinutes,
      amounts.internetMb,
      amounts.phoneCharge,
      amounts.internetCharge,
      amounts.total,
      amounts.tariffId,
    ],
  );
  return Bill.fromRow(rows[0]!);
}
