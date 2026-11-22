// User queries: plain SQL in, domain objects out.
import { User, type UserRow } from "../domain/user";
import type { Db } from "./db";

// Usernames are matched case-insensitively (like the teacher's .ToLower() compare).
export async function findUserByUsername(db: Db, username: string): Promise<User | null> {
  const { rows } = await db.query<UserRow>(
    `SELECT u.id, u.username, u.password_hash, s.subscriber_no
       FROM billing.users u
       JOIN billing.subscribers s ON s.id = u.subscriber_id
      WHERE lower(u.username) = lower($1)`,
    [username],
  );
  const row = rows[0];
  return row ? User.fromRow(row) : null;
}
