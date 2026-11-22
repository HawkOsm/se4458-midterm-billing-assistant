// Demo data for local runs and for the instructor (the spec has no sign-up endpoint).
// Run: npm run seed            (local database only)
//      npm run seed -- --allow-remote   (on purpose, e.g. the hosted demo on RDS)
// Safe to run again: accounts are updated, usage has fixed keys (never added twice), and
// a month that was already paid is left as it is.
//
// Lives in scripts/, not src/, so it is never compiled into dist/ or the Docker image.
// Passwords come from the environment, never from this file: .env locally, and
// whatever you choose for the hosted demo (the README lists the demo logins).
import type { PoolClient } from "pg";
import { z } from "zod";
import { config, isLocalDatabase } from "../src/config";
import { isAmazonRds } from "../src/db/databaseGuard";
import { pool } from "../src/db/db";
import { BillService } from "../src/services/billService";
import { hashPassword } from "../src/services/passwordHasher";

const SUBSCRIBERS = [
  { subscriberNo: "5551234", fullName: "Ayse Yilmaz", username: "ayse", passwordEnv: "SEED_PASSWORD_AYSE" },
  { subscriberNo: "5559999", fullName: "Mehmet Kaya", username: "mehmet", passwordEnv: "SEED_PASSWORD_MEHMET" },
] as const;

// The provider's operator: records usage and calculates bills for any subscriber.
const ADMIN = { username: "admin", passwordEnv: "SEED_PASSWORD_ADMIN" } as const;

// Usage for the assignment's example questions ("What is my October bill?", "Why is my
// October bill higher?"). Each entry is `rows` events of `amount` (minutes or MB) each.
const DEMO_USAGE = [
  // Ayse, September 2026: 800 min (free) + 15 GB ($50) = $50
  { subscriberNo: "5551234", year: 2026, month: 9, type: "PHONE", rows: 8, amount: 100 },
  { subscriberNo: "5551234", year: 2026, month: 9, type: "INTERNET", rows: 15, amount: 1000 },
  // Ayse, October 2026: the guide's worked example (§4.3), 1,350 min + 35 GB = $80
  { subscriberNo: "5551234", year: 2026, month: 10, type: "PHONE", rows: 27, amount: 50 },
  { subscriberNo: "5551234", year: 2026, month: 10, type: "INTERNET", rows: 35, amount: 1000 },
  // Mehmet, October 2026: 2,500 min ($20) + 18 GB ($50) = $70
  { subscriberNo: "5559999", year: 2026, month: 10, type: "PHONE", rows: 25, amount: 100 },
  { subscriberNo: "5559999", year: 2026, month: 10, type: "INTERNET", rows: 18, amount: 1000 },
] as const;

const ALLOW_REMOTE = process.argv.includes("--allow-remote");
const REMOTE_HINT = "Re-run with `npm run seed -- --allow-remote` if this is intended.";

// Stops before touching the database if the target isn't local, unless asked explicitly:
// a wrong .env must not plant publicly known logins on the deployed database.
function assertSafeTarget(): void {
  if (isLocalDatabase(config) || ALLOW_REMOTE) return;
  throw new Error(`Refusing to seed ${config.POSTGRES_HOST}: not a local database. ${REMOTE_HINT}`);
}

// Every password must be set; report all missing names at once.
function readPasswords(): Record<string, string> {
  const names = [...SUBSCRIBERS.map((a) => a.passwordEnv), ADMIN.passwordEnv];
  const shape = Object.fromEntries(names.map((name) => [name, z.string().min(8, "at least 8 characters")]));
  const result = z.object(shape).safeParse(process.env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join(".")} (${i.message})`);
    throw new Error(`Set these in .env first: ${problems.join(", ")}`);
  }
  return result.data;
}

async function seedAccounts(client: PoolClient, passwords: Record<string, string>): Promise<void> {
  for (const account of SUBSCRIBERS) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO billing.subscribers (subscriber_no, full_name) VALUES ($1, $2)
       ON CONFLICT (subscriber_no) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING id`,
      [account.subscriberNo, account.fullName],
    );
    await client.query(
      `INSERT INTO billing.users (subscriber_id, username, password_hash, role) VALUES ($1, $2, $3, 'SUBSCRIBER')
       ON CONFLICT (subscriber_id) DO UPDATE
         SET username = EXCLUDED.username, password_hash = EXCLUDED.password_hash`,
      [rows[0]!.id, account.username, await hashPassword(passwords[account.passwordEnv]!)],
    );
  }
  await client.query(
    `INSERT INTO billing.users (subscriber_id, username, password_hash, role) VALUES (NULL, $1, $2, 'ADMIN')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'ADMIN', subscriber_id = NULL`,
    [ADMIN.username, await hashPassword(passwords[ADMIN.passwordEnv]!)],
  );
}

// Fixed idempotency keys: running the seed again adds nothing.
async function seedUsage(client: PoolClient): Promise<number> {
  let added = 0;
  for (const u of DEMO_USAGE) {
    const { rowCount } = await client.query(
      `INSERT INTO billing.usage_events (subscriber_id, period_year, period_month, usage_type, amount, idempotency_key)
       SELECT s.id, $2, $3, $4, $5, $7::text || g
         FROM billing.subscribers s, generate_series(1, $6::int) AS g
        WHERE s.subscriber_no = $1
       ON CONFLICT (subscriber_id, idempotency_key) DO NOTHING`,
      [u.subscriberNo, u.year, u.month, u.type, u.amount, u.rows, `seed-${u.subscriberNo}-${u.year}-${u.month}-${u.type}-`],
    );
    added += rowCount ?? 0;
  }
  return added;
}

// The bills are made by the real Calculate Bill code, so they match what the API does.
async function calculateDemoBills(): Promise<string[]> {
  const service = new BillService(pool);
  const periods = [...new Set(DEMO_USAGE.map((u) => `${u.subscriberNo}/${u.year}/${u.month}`))];
  const lines: string[] = [];
  for (const period of periods) {
    const [no, year, month] = period.split("/");
    const result = await service.calculate(no!, Number(year), Number(month));
    const total = "bill" in result ? ` $${result.bill.totalCents / 100}` : "";
    lines.push(`${no} ${year}-${month}: ${result.kind}${total}`);
  }
  return lines;
}

async function main(): Promise<void> {
  assertSafeTarget();
  const passwords = readPasswords();
  const client = await pool.connect();
  let added: number;
  try {
    // Settings can't see through a tunnel (127.0.0.1 forwarded to RDS); the database can.
    if (!ALLOW_REMOTE && (await isAmazonRds(client))) {
      throw new Error(`Refusing to seed: the connected database is Amazon RDS. ${REMOTE_HINT}`);
    }
    await client.query("BEGIN");
    await seedAccounts(client, passwords);
    added = await seedUsage(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  const bills = await calculateDemoBills();
  console.log(`Seeded on ${config.POSTGRES_HOST}: users ${[...SUBSCRIBERS.map((a) => a.username), ADMIN.username].join(", ")}`);
  console.log(`Demo usage: ${added} new events. Bills:\n  ${bills.join("\n  ")}`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
