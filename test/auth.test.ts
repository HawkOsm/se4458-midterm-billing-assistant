// POST /api/v1/login
import "./testEnv"; // before src/config is imported (it reads process.env once)
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app";
import { apiConfig } from "../src/config";
import { LoginLimiter } from "../src/services/loginLimiter";
import {
  beginTestTransaction,
  closePool,
  insertUser,
  listen,
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

  const claims = jwt.verify(body.accessToken, apiConfig().JWT_SECRET) as jwt.JwtPayload;
  assert.equal(claims.sub, "5551234");
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

// ---------- lockout: 3 wrong passwords, then 30 seconds ----------

const wrong = () => api.postJson("/api/v1/login", { username: "ayse", password: "wrong" });
const right = (username = "ayse") => api.postJson("/api/v1/login", { username, password: "correct-horse" });

test("after 3 wrong passwords the username is locked: 429 with Retry-After, even for the right password", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await wrong()).status, 401, `wrong try ${i + 1}`);

  const res = await right();
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "30");
  assert.deepEqual(await res.json(), { error: "Too many failed logins. Try again in 30 seconds" });
  assert.equal((await right(" AYSE ")).status, 429, "the same account in another spelling");
});

test("two wrong passwords don't lock, and a successful login resets the count", async () => {
  await wrong();
  await wrong();
  assert.equal((await right()).status, 200);
  await wrong();
  await wrong();
  assert.equal((await right()).status, 200, "still 2 in a row, not 4");
});

test("a lock is per username: other users can still log in, and unknown names lock the same way", async () => {
  await insertUser(tx.client, "5559999", "mehmet", "correct-horse");
  for (let i = 0; i < 3; i++) await wrong();
  assert.equal((await right("mehmet")).status, 200);

  const nobody = () => api.postJson("/api/v1/login", { username: "nobody", password: "x" });
  for (let i = 0; i < 3; i++) assert.equal((await nobody()).status, 401);
  assert.equal((await nobody()).status, 429, "doesn't reveal that the name doesn't exist");
});

test("after 30 seconds the lock ends and there are 3 new tries", async () => {
  let now = 1_000_000;
  const timed = await listen(createApp(tx.client, { loginLimiter: new LoginLimiter(() => now) }));
  const login = (password: string) => timed.postJson("/api/v1/login", { username: "ayse", password });
  try {
    for (let i = 0; i < 3; i++) await login("wrong");
    now += 29_000;
    const locked = await login("correct-horse");
    assert.equal(locked.status, 429);
    assert.equal(locked.headers.get("retry-after"), "1");

    now += 1_000;
    assert.equal((await login("wrong")).status, 401, "try 1 of the new 3");
    assert.equal((await login("wrong")).status, 401);
    assert.equal((await login("correct-horse")).status, 200, "the third try still works");
  } finally {
    await timed.close();
  }
});
