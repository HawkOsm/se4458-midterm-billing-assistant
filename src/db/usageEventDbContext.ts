// Usage event queries: plain SQL in, domain objects out.
import { UsageEvent, type Page, type UsageEventRow } from "../domain/usageEvent";
import type { Db } from "./db";

// One page of the events a stored bill counted (Calculate Bill links them with bill_id),
// newest first. Both parts are served straight from ix_usage_events_bill_id_created_at_id:
// the count from the index, and the page by walking it in order and stopping after
// offset + limit rows, instead of loading and sorting every event of the month.
// The LEFT JOIN keeps one row (with the total) even when the offset is past the end.
export async function getEventsForBill(
  db: Db,
  billId: number,
  offset: number,
  limit: number,
): Promise<Page<UsageEvent>> {
  const { rows } = await db.query<{ total: string } & Partial<UsageEventRow>>(
    `SELECT t.total, p.id, p.usage_type, p.amount, p.created_at
       FROM (SELECT count(*) AS total FROM billing.usage_events WHERE bill_id = $1) t
       LEFT JOIN LATERAL (
         SELECT id, usage_type, amount, created_at
           FROM billing.usage_events
          WHERE bill_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2 OFFSET $3
       ) p ON true`,
    [billId, limit, offset],
  );
  const total = Number(rows[0]?.total ?? 0);
  const items = rows
    .filter((r): r is { total: string } & UsageEventRow => r.id !== null && r.id !== undefined)
    .map(UsageEvent.fromRow);
  return { items, offset, limit, total };
}
