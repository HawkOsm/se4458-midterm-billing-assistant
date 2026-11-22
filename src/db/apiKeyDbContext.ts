// API key queries.
import type { Db } from "./db";

// The name of the active (not revoked) key with this hash, or null.
export async function findActiveKeyName(db: Db, keyHash: string): Promise<string | null> {
  const { rows } = await db.query<{ name: string }>(
    "SELECT name FROM billing.api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
    [keyHash],
  );
  return rows[0]?.name ?? null;
}
