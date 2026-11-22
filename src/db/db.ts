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
