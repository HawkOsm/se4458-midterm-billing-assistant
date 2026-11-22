// POST /api/v1/login
import "./testEnv"; // before src/config is imported (it reads process.env once)
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import jwt from "jsonwebtoken";
import { config } from "../src/config";
import {
  beginTestTransaction,
  closePool,
  insertAdmin,
  insertUser,
  prepareTestDatabase,
  startTestServer,
  type TestServer,
  type TestTx,
} from "./helpers";

let tx: TestTx;
let api: TestServer;

before(prepareTestDatabase);
after(closePool);
beforeEach(async () => {
  tx = await beginTestTransaction();
  api = await startTestServer(tx.client);
  await insertUser(tx.client, "5551234", "ayse", "correct-horse");
});
afterEach(async () => {
  await api.close();
  await tx.rollback();
});

test("valid credentials return a 15-minute Bearer token for the subscriber", async () => {
  const res = await api.postJson("/api/v1/login", { username: "ayse", password: "correct-horse" });
  const body = (await res.json()) as { accessToken: string; tokenType: string; expiresIn: number };

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(body.tokenType, "Bearer");
  assert.equal(body.expiresIn, 900);

  const claims = jwt.verify(body.accessToken, config.JWT_SECRET) as jwt.JwtPayload;
  assert.equal(claims.sub, "5551234");
  assert.equal(claims["role"], "SUBSCRIBER");
  assert.equal(claims.iss, "billing-api");
  assert.equal(claims.aud, "billing-assistant");
  assert.equal(claims.exp! - claims.iat!, 900);
});

test("username match ignores case and surrounding spaces", async () => {
  const res = await api.postJson("/api/v1/login", { username: "  AYSE ", password: "correct-horse" });

  assert.equal(res.status, 200);
});

test("wrong password returns 401", async () => {
  const res = await api.postJson("/api/v1/login", { username: "ayse", password: "wrong" });

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Invalid username or password" });
});

test("unknown username gets exactly the same 401 as a wrong password", async () => {
  const res = await api.postJson("/api/v1/login", { username: "nobody", password: "correct-horse" });

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Invalid username or password" });
});

test("password is case-sensitive", async () => {
  const res = await api.postJson("/api/v1/login", { username: "ayse", password: "CORRECT-HORSE" });

  assert.equal(res.status, 401);
});

test("missing fields return 400", async () => {
  const res = await api.postJson("/api/v1/login", { username: "ayse" });
  const body = (await res.json()) as { error: string };

  assert.equal(res.status, 400);
  assert.match(body.error, /^password: /);
});

test("a body that isn't valid JSON returns 400, not 500", async () => {
  const res = await api.postJson("/api/v1/login", '{"username": "ayse",');

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Request body is not valid JSON" });
});

test("the password is stored as a scrypt hash, never in plaintext", async () => {
  const { rows } = await tx.client.query<{ password_hash: string }>(
    "SELECT password_hash FROM billing.users WHERE username = 'ayse'",
  );

  assert.match(rows[0]!.password_hash, /^scrypt\$16384\$8\$5\$/);
  assert.ok(!rows[0]!.password_hash.includes("correct-horse"));
});

test("a second user named Ayse (different case) is rejected by the database", async () => {
  await tx.client.query("SAVEPOINT dup");
  await assert.rejects(
    insertUser(tx.client, "5559999", "Ayse", "other"),
    (err: { constraint?: string }) => err.constraint === "uq_users_username_lower",
  );
  await tx.client.query("ROLLBACK TO SAVEPOINT dup");
});

test("the provider's admin logs in with role ADMIN and its username as subject", async () => {
  await insertAdmin(tx.client, "ops", "admin-pass-123");

  const res = await api.postJson("/api/v1/login", { username: "ops", password: "admin-pass-123" });
  const claims = jwt.verify(((await res.json()) as { accessToken: string }).accessToken, config.JWT_SECRET) as jwt.JwtPayload;

  assert.equal(res.status, 200);
  assert.equal(claims.sub, "ops");
  assert.equal(claims["role"], "ADMIN");
});

