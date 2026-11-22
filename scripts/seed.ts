// Demo data for local runs and for the instructor (the spec has no sign-up endpoint).
// Run: npm run seed            (local database only)
//      npm run seed -- --allow-remote   (on purpose, e.g. the hosted demo on RDS)
// Safe to run again: existing rows are updated, not duplicated.
//
// Lives in scripts/, not src/, so it is never compiled into dist/ or the Docker image.
// Passwords come from the environment, never from this file: .env locally, and
// whatever you choose for the hosted demo (the README lists the demo logins).
import { z } from "zod";
import { config, isLocalHost } from "../src/config";
import { pool } from "../src/db/db";
import { hashPassword } from "../src/services/passwordHasher";

const DEMO_ACCOUNTS = [
  { subscriberNo: "5551234", fullName: "Ayse Yilmaz", username: "ayse", passwordEnv: "SEED_PASSWORD_AYSE" },
  { subscriberNo: "5559999", fullName: "Mehmet Kaya", username: "mehmet", passwordEnv: "SEED_PASSWORD_MEHMET" },
] as const;

// Stops before touching the database if the target isn't local, unless asked explicitly:
// a wrong .env must not plant publicly known logins on the deployed database.
function assertSafeTarget(): void {
  if (isLocalHost(config.POSTGRES_HOST) || process.argv.includes("--allow-remote")) return;
  throw new Error(
    `Refusing to seed ${config.POSTGRES_HOST}: not a local database. ` +
      "Re-run with `npm run seed -- --allow-remote` if this is intended.",
  );
}

// Every password must be set; report all missing names at once.
function readPasswords(): Record<string, string> {
  const shape = Object.fromEntries(
    DEMO_ACCOUNTS.map((a) => [a.passwordEnv, z.string().min(8, "at least 8 characters")]),
  );
  const result = z.object(shape).safeParse(process.env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join(".")} (${i.message})`);
    throw new Error(`Set these in .env first: ${problems.join(", ")}`);
  }
  return result.data;
}

async function main(): Promise<void> {
  assertSafeTarget();
  const passwords = readPasswords();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const account of DEMO_ACCOUNTS) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO billing.subscribers (subscriber_no, full_name) VALUES ($1, $2)
         ON CONFLICT (subscriber_no) DO UPDATE SET full_name = EXCLUDED.full_name
         RETURNING id`,
        [account.subscriberNo, account.fullName],
      );
      await client.query(
        `INSERT INTO billing.users (subscriber_id, username, password_hash) VALUES ($1, $2, $3)
         ON CONFLICT (subscriber_id) DO UPDATE
           SET username = EXCLUDED.username, password_hash = EXCLUDED.password_hash`,
        [rows[0]!.id, account.username, await hashPassword(passwords[account.passwordEnv]!)],
      );
    }
    await client.query("COMMIT");
    console.log(
      `Seeded ${DEMO_ACCOUNTS.length} demo accounts on ${config.POSTGRES_HOST}: ` +
        DEMO_ACCOUNTS.map((a) => a.username).join(", "),
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
