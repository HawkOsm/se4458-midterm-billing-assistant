// Subscriber queries: plain SQL in, plain values out.
import type { Db } from "./db";

export async function findSubscriberId(db: Db, subscriberNo: string): Promise<number | null> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM billing.subscribers WHERE subscriber_no = $1",
    [subscriberNo],
  );
  const row = rows[0];
  return row ? Number(row.id) : null;
}
