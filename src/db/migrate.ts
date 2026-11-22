import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { pool } from "./db";

// Plain-SQL migrations: migrations/NNN_name.sql, applied once each, in file-name order.
// Same idea as Alembic: the database records which files already ran.
// Path works from src/db (tsx) and dist/db (compiled): both are two levels below the root.
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");

// Any fixed number: while one process holds this lock, others wait (e.g. two ECS tasks).
const LOCK_ID = 4458;

export async function migrate(client: PoolClient): Promise<string[]> {
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ name: string }>(
      "SELECT name FROM public.schema_migrations",
    );
    const done = new Set(rows.map((r) => r.name));
    const pending = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && !done.has(f))
      .sort();

    for (const file of pending) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      // One transaction per file: a failing file leaves no half-applied schema.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO public.schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return pending;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
  }
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    const applied = await migrate(client);
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Already up to date");
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
