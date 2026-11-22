// Usage event queries: plain SQL in, domain objects out.
import { UsageEvent, type Page, type UsageEventRow } from "../domain/usageEvent";
import type { Db } from "./db";

// One page of the events counted in a stored bill: same subscriber and period, recorded
// no later than the bill's calculation (later usage isn't in its total). Newest first.
//
// One statement on purpose: the total and the page come from the same snapshot, so a
// concurrent Add Usage can't make them disagree. The LEFT JOIN keeps one row (with the
// total) even when the offset is past the end and the page is empty.
export async function getEventsForBill(
  db: Db,
  billId: number,
  offset: number,
  limit: number,
): Promise<Page<UsageEvent>> {
  const { rows } = await db.query<{ total: string } & Partial<UsageEventRow>>(
    `WITH counted AS (
       SELECT e.id, e.usage_type, e.amount, e.created_at
         FROM billing.usage_events e
         JOIN billing.bills b
           ON b.subscriber_id = e.subscriber_id
          AND b.period_year = e.period_year
          AND b.period_month = e.period_month
        WHERE b.id = $1
          AND e.created_at <= b.calculated_at
     )
     SELECT t.total, p.*
       FROM (SELECT count(*) AS total FROM counted) t
       LEFT JOIN LATERAL (
         SELECT * FROM counted ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3
       ) p ON true`,
    [billId, limit, offset],
  );
  const total = Number(rows[0]?.total ?? 0);
  const items = rows
    .filter((r): r is { total: string } & UsageEventRow => r.id !== null && r.id !== undefined)
    .map(UsageEvent.fromRow);
  return { items, offset, limit, total };
}
