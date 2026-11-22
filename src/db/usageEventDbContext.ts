// Usage event queries: plain SQL in, domain objects out.
import {
  UNIT_AMOUNT,
  UsageEvent,
  type Page,
  type RecordedUsage,
  type UsageEventRow,
  type UsageType,
} from "../domain/usageEvent";
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

// ---------- Add Usage (each step runs inside the caller's transaction) ----------

type RecordedRow = UsageEventRow & { period_year: number; period_month: number };

function toRecorded(row: RecordedRow): RecordedUsage {
  const event = UsageEvent.fromRow(row);
  return { event, year: row.period_year, month: row.period_month, quantity: event.amount / UNIT_AMOUNT[event.type] };
}

const RECORDED_COLUMNS = "id, usage_type, amount, created_at, period_year, period_month";

// The event this subscriber already recorded under this Idempotency-Key, if any.
export async function findByIdempotencyKey(
  db: Db,
  subscriberId: number,
  key: string,
): Promise<RecordedUsage | null> {
  const { rows } = await db.query<RecordedRow>(
    `SELECT ${RECORDED_COLUMNS} FROM billing.usage_events
      WHERE subscriber_id = $1 AND idempotency_key = $2`,
    [subscriberId, key],
  );
  const row = rows[0];
  return row ? toRecorded(row) : null;
}

// Inserts the event, or nothing if this key was just used by a concurrent request (the
// unique key makes the second request wait for the first, then skip). null = skipped.
export async function insertUsageEvent(
  db: Db,
  usage: { subscriberId: number; year: number; month: number; type: UsageType; amount: number; key: string },
): Promise<RecordedUsage | null> {
  const { rows } = await db.query<RecordedRow>(
    `INSERT INTO billing.usage_events
         (subscriber_id, period_year, period_month, usage_type, amount, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (subscriber_id, idempotency_key) DO NOTHING
     RETURNING ${RECORDED_COLUMNS}`,
    [usage.subscriberId, usage.year, usage.month, usage.type, usage.amount, usage.key],
  );
  const row = rows[0];
  return row ? toRecorded(row) : null;
}
