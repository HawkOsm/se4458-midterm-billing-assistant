// Shared test setup. Tests run against a real PostgreSQL database (billing_test) in the
// local Docker container, so SQL and constraints are exercised for real. Each test runs
// inside a transaction that is rolled back, so tests never see each other's data.
// No cloud, network or LLM is needed: `docker compose up -d` is enough.
import "./testEnv";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { Client, type PoolClient } from "pg";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { pool } from "../src/db/db";
import { migrate } from "../src/db/migrate";
import { hashPassword } from "../src/services/passwordHasher";

const DUPLICATE_DATABASE = "42P04";

// Once per test file: create billing_test if needed and bring it to the latest migration.
export async function prepareTestDatabase(): Promise<void> {
  const admin = new Client({
    host: config.POSTGRES_HOST,
    port: config.POSTGRES_PORT,
    user: config.POSTGRES_USER,
    password: config.POSTGRES_PASSWORD,
    database: "postgres",
  });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${config.POSTGRES_DB}"`);
  } catch (err) {
    if ((err as { code?: string }).code !== DUPLICATE_DATABASE) throw err;
  } finally {
    await admin.end();
  }
  const client = await pool.connect();
  try {
    await migrate(client);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

// One connection with an open transaction; rollback() undoes everything the test did.
export interface TestTx {
  client: PoolClient;
  rollback: () => Promise<void>;
}

export async function beginTestTransaction(): Promise<TestTx> {
  const client = await pool.connect();
  await client.query("BEGIN");
  return {
    client,
    rollback: async () => {
      await client.query("ROLLBACK");
      client.release();
    },
  };
}

// The real Express app on a random free port, using the test's transaction.
export interface TestServer {
  get: (path: string, headers?: Record<string, string>) => Promise<Response>;
  put: (path: string, headers?: Record<string, string>) => Promise<Response>;
  postJson: (path: string, body: unknown, headers?: Record<string, string>) => Promise<Response>;
  close: () => Promise<void>;
}

export async function startTestServer(client: PoolClient): Promise<TestServer> {
  return listen(createApp(client));
}

// Any Express app on a random free port (also used for middleware-only test apps).
export async function listen(app: Express): Promise<TestServer> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    get: (path, headers = {}) => fetch(base + path, { headers }),
    put: (path, headers = {}) => fetch(base + path, { method: "PUT", headers }),
    postJson: (path, body, headers = {}) =>
      fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// A login for an existing subscriber, with a real scrypt hash.
export async function insertUser(
  client: PoolClient,
  subscriberNo: string,
  username: string,
  password: string,
): Promise<void> {
  const subscriberId = await insertSubscriber(client, subscriberNo);
  await client.query(
    "INSERT INTO billing.users (subscriber_id, username, password_hash) VALUES ($1, $2, $3)",
    [subscriberId, username, await hashPassword(password)],
  );
}

// Test data: a subscriber and a stored bill (charges in "75.00" text, like NUMERIC).
export interface BillSeed {
  subscriberNo?: string;
  year?: number;
  month?: number;
  phoneCharge?: string;
  internetCharge?: string;
  paidAmount?: string;
  status?: "UNPAID" | "PARTIALLY_PAID" | "PAID";
  phoneMinutes?: number;
  internetMb?: number;
}

export async function insertSubscriber(client: PoolClient, subscriberNo: string): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO billing.subscribers (subscriber_no, full_name) VALUES ($1, 'Test User')
     ON CONFLICT (subscriber_no) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`,
    [subscriberNo],
  );
  return Number(rows[0]!.id);
}

export async function insertBill(client: PoolClient, seed: BillSeed = {}): Promise<number> {
  const subscriberId = await insertSubscriber(client, seed.subscriberNo ?? "5551234");
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO billing.bills (subscriber_id, period_year, period_month, phone_minutes,
         internet_mb, phone_charge, internet_charge, total, paid_amount, status)
     VALUES ($1, $2, $3, $8, $9, $4::numeric, $5::numeric, $4::numeric + $5::numeric, $6, $7)
     RETURNING id`,
    [
      subscriberId,
      seed.year ?? 2025,
      seed.month ?? 4,
      seed.phoneCharge ?? "25.00",
      seed.internetCharge ?? "50.00",
      seed.paidAmount ?? "0.00",
      seed.status ?? "UNPAID",
      seed.phoneMinutes ?? 0,
      seed.internetMb ?? 0,
    ],
  );
  return Number(rows[0]!.id);
}

// `count` usage events for one period, recorded 1 second apart ending at
// `endSecondsFromNow` seconds from the transaction's now(). With `billId`, the events are
// linked to that bill, as Calculate Bill will do for the events it counts.
export async function insertUsageEvents(
  client: PoolClient,
  subscriberNo: string,
  usage: {
    year: number;
    month: number;
    type: "PHONE" | "INTERNET";
    count: number;
    endSecondsFromNow?: number;
    billId?: number;
  },
): Promise<void> {
  const subscriberId = await insertSubscriber(client, subscriberNo);
  await client.query(
    `INSERT INTO billing.usage_events
       (subscriber_id, period_year, period_month, usage_type, amount, idempotency_key, created_at, bill_id)
     SELECT $1, $2, $3, $4::varchar, CASE WHEN $4::varchar = 'PHONE' THEN 10 ELSE 1 END,
            $7::text || g,
            now() + make_interval(secs => $6::int - (g - 1)),
            $8::bigint
       FROM generate_series(1, $5::int) AS g`,
    [
      subscriberId,
      usage.year,
      usage.month,
      usage.type,
      usage.count,
      usage.endSecondsFromNow ?? 0,
      `test-${randomUUID()}-`, // unique per call, like real Idempotency-Keys
      usage.billId ?? null,
    ],
  );
}

// The provider's admin login (role ADMIN, no subscriber).
export async function insertAdmin(client: PoolClient, username: string, password: string): Promise<void> {
  await client.query(
    "INSERT INTO billing.users (subscriber_id, username, password_hash, role) VALUES (NULL, $1, $2, 'ADMIN')",
    [username, await hashPassword(password)],
  );
}

