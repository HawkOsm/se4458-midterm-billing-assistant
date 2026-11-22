import { Pool, type PoolClient } from "pg";
import { config } from "../config";

// One connection pool per process (like the teacher's db/db.js holds one database handle).
export const pool = new Pool({
  host: config.POSTGRES_HOST,
  port: config.POSTGRES_PORT,
  database: config.POSTGRES_DB,
  user: config.POSTGRES_USER,
  password: config.POSTGRES_PASSWORD,
  ssl: config.POSTGRES_SSL ? { rejectUnauthorized: true } : false,
  max: 10,
});

// Anything that can run a query: the pool itself, or one client inside a transaction.
// DB contexts accept this, so a service can pass a transaction client (Pay Bill) and
// tests can pass a client whose transaction is rolled back afterwards.
export type Db = Pool | PoolClient;

export type IsolationLevel = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

let savepointSeq = 0;

// Runs `work` inside one transaction on one connection, so every query in it sees the
// same data (REPEATABLE READ: one snapshot for the whole transaction) and writes are
// all-or-nothing. Given the pool, it borrows a connection and owns BEGIN/COMMIT/ROLLBACK.
// Given a client, the caller already owns the transaction (tests, nested service calls):
// a SAVEPOINT keeps `work` all-or-nothing inside it (isolation is the caller's).
export async function withTransaction<T>(
  db: Db,
  work: (tx: Db) => Promise<T>,
  options: { isolation?: IsolationLevel; readOnly?: boolean } = {},
): Promise<T> {
  if (!(db instanceof Pool)) return withSavepoint(db, work);
  const client = await db.connect();
  try {
    const mode = options.readOnly ? " READ ONLY" : "";
    await client.query(`BEGIN ISOLATION LEVEL ${options.isolation ?? "READ COMMITTED"}${mode}`);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined); // keep the original error
    throw err;
  } finally {
    client.release();
  }
}

const NO_ACTIVE_TRANSACTION = "25P01"; // SAVEPOINT outside BEGIN ... COMMIT

async function withSavepoint<T>(client: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  const name = `sp_${++savepointSeq}`;
  try {
    await client.query(`SAVEPOINT ${name}`);
  } catch (err) {
    // The client isn't in a transaction yet: open one ourselves instead.
    if ((err as { code?: string }).code !== NO_ACTIVE_TRANSACTION) throw err;
    return withOwnTransaction(client, work);
  }
  try {
    const result = await work(client);
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined); // keep the original error
    throw err;
  }
}

async function withOwnTransaction<T>(client: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined); // keep the original error
    throw err;
  }
}

