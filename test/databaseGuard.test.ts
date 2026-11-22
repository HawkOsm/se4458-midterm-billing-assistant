// The startup check that asks the database itself whether it is Amazon RDS.
import "./testEnv";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { parseConfig } from "../src/config";
import { assertSafeSigningKey, isAmazonRds } from "../src/db/databaseGuard";
import type { Db } from "../src/db/db";
import { pool } from "../src/db/db";
import { closePool, prepareTestDatabase } from "./helpers";

before(prepareTestDatabase);
after(closePool);

// Stands in for an RDS connection: answers the one query the guard sends.
const fakeRds = { query: async () => ({ rows: [{ setting: "pg_stat_statements,plpgsql" }] }) } as unknown as Db;

const devKeyLocal = parseConfig({ JWT_SECRET: "local-dev-only-public-key-for-this-test", POSTGRES_HOST: "127.0.0.1" });
const privateKey = parseConfig({ JWT_SECRET: "a-private-random-key-0123456789abcdef" });

test("the local Docker Postgres is not RDS", async () => {
  assert.equal(await isAmazonRds(pool), false);
});

test("a database exposing rds.extensions is RDS", async () => {
  assert.equal(await isAmazonRds(fakeRds), true);
});

test("the public dev key is refused on RDS even when the settings look local (tunnel)", async () => {
  await assert.rejects(assertSafeSigningKey(fakeRds, devKeyLocal), /connected database is Amazon RDS/);
});

test("the public dev key is fine on the local database", async () => {
  await assertSafeSigningKey(pool, devKeyLocal);
});

test("a private key is fine on RDS", async () => {
  await assertSafeSigningKey(fakeRds, privateKey);
});
