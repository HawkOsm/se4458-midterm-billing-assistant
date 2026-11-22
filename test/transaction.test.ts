// withTransaction: one connection, the requested isolation, all-or-nothing.
import "./testEnv";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { pool, withTransaction } from "../src/db/db";
import { closePool, prepareTestDatabase } from "./helpers";

before(prepareTestDatabase);
after(closePool);

test("runs in REPEATABLE READ, READ ONLY when asked", async () => {
  const seen = await withTransaction(
    pool,
    async (tx) => {
      const { rows } = await tx.query<{ iso: string; ro: string }>(
        "SELECT current_setting('transaction_isolation') AS iso, current_setting('transaction_read_only') AS ro",
      );
      return rows[0];
    },
    { isolation: "REPEATABLE READ", readOnly: true },
  );
  assert.deepEqual(seen, { iso: "repeatable read", ro: "on" });
});

test("rolls back everything when the work throws", async () => {
  const no = `tx${Date.now()}`; // fits subscriber_no VARCHAR(20)
  await assert.rejects(
    withTransaction(pool, async (tx) => {
      await tx.query("INSERT INTO billing.subscribers (subscriber_no, full_name) VALUES ($1, 'Rollback')", [no]);
      throw new Error("boom");
    }),
    /boom/,
  );
  const { rows } = await pool.query("SELECT 1 FROM billing.subscribers WHERE subscriber_no = $1", [no]);
  assert.equal(rows.length, 0);
});
