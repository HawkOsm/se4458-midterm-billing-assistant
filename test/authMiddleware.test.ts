// requireAuth + requireOwnAccount, tested on a test-only route so no real endpoint
// is needed yet. Every forged-token case must end in 401, never in the handler.
import "./testEnv";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import { errorHandler } from "../src/app";
import { config } from "../src/config";
import { getAuth, requireAdmin, requireAuth, requireOwnAccount, requireOwnAccountOrAdmin } from "../src/middleware/auth";
import { issueToken } from "../src/services/tokenService";
import { listen, type TestServer } from "./helpers";

let api: TestServer;

before(async () => {
  const app = express();
  const who = (_req: express.Request, res: express.Response): void => {
    const auth = getAuth(res);
    res.json({ ok: true, ...(auth.role === "ADMIN" ? { admin: auth.username } : { subscriberNo: auth.subscriberNo }) });
  };
  app.get("/subscribers/:subscriberNo/private", requireAuth, requireOwnAccount, who);
  app.get("/subscribers/:subscriberNo/support", requireAuth, requireOwnAccountOrAdmin, who);
  app.get("/subscribers/:subscriberNo/admin-only", requireAuth, requireAdmin, who);
  app.use(errorHandler);
  api = await listen(app);
});
after(() => api.close());

const PATH = "/subscribers/5551234/private";
const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const valid = { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE, subject: "5551234" };

test("a valid token for the same subscriber gets through", async () => {
  const { accessToken } = issueToken({ role: "SUBSCRIBER", subscriberNo: "5551234" });

  const res = await api.get(PATH, bearer(accessToken));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, subscriberNo: "5551234" });
});

test("a valid token for another subscriber is refused with 403", async () => {
  const { accessToken } = issueToken({ role: "SUBSCRIBER", subscriberNo: "5559999" });

  const res = await api.get(PATH, bearer(accessToken));

  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "You can only access your own account" });
});

test("no Authorization header returns 401 with WWW-Authenticate", async () => {
  const res = await api.get(PATH);

  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer/);
});

const forged: [string, () => string][] = [
  ["signed with another secret", () => jwt.sign({ role: "SUBSCRIBER" }, "x".repeat(40), { ...valid, expiresIn: 900 })],
  ["expired", () => jwt.sign({ role: "SUBSCRIBER", exp: Math.floor(Date.now() / 1000) - 5 }, config.JWT_SECRET, valid)],
  ["for another audience", () => jwt.sign({ role: "SUBSCRIBER" }, config.JWT_SECRET, { ...valid, audience: "other-app", expiresIn: 900 })],
  ["from another issuer", () => jwt.sign({ role: "SUBSCRIBER" }, config.JWT_SECRET, { ...valid, issuer: "evil", expiresIn: 900 })],
  ["with no subject", () => jwt.sign({ role: "SUBSCRIBER" }, config.JWT_SECRET, { issuer: valid.issuer, audience: valid.audience, expiresIn: 900 })],
  ["using alg none (unsigned)", () => {
    const part = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    return `${part({ alg: "none", typ: "JWT" })}.${part({ sub: "5551234", role: "SUBSCRIBER", iss: valid.issuer, aud: valid.audience, exp: now + 900 })}.`;
  }],
  ["that is garbage", () => "not-a-jwt"],
];

for (const [name, makeToken] of forged) {
  test(`a token ${name} returns 401`, async () => {
    const res = await api.get(PATH, bearer(makeToken()));

    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Invalid or expired token" });
  });
}

test("a non-Bearer scheme returns 401", async () => {
  const { accessToken } = issueToken({ role: "SUBSCRIBER", subscriberNo: "5551234" });

  const res = await api.get(PATH, { Authorization: `Basic ${accessToken}` });

  assert.equal(res.status, 401);
});

// ---------- roles (migration 006) ----------

const subscriberToken = (no: string): Record<string, string> =>
  bearer(issueToken({ role: "SUBSCRIBER", subscriberNo: no }).accessToken);
const adminToken = bearer(issueToken({ role: "ADMIN", username: "admin" }).accessToken);

test("own-or-admin: the own subscriber and the admin pass, another subscriber gets 403", async () => {
  assert.equal((await api.get("/subscribers/5551234/support", subscriberToken("5551234"))).status, 200);
  assert.deepEqual(await (await api.get("/subscribers/5551234/support", adminToken)).json(), { ok: true, admin: "admin" });
  assert.equal((await api.get("/subscribers/5551234/support", subscriberToken("5559999"))).status, 403);
});

test("admin-only: any subscriber gets 403, even for their own number", async () => {
  assert.equal((await api.get("/subscribers/5551234/admin-only", subscriberToken("5551234"))).status, 403);
  assert.equal((await api.get("/subscribers/5551234/admin-only", adminToken)).status, 200);
});

test("own-only: the admin gets 403 (it can't act as the subscriber)", async () => {
  assert.equal((await api.get(PATH, adminToken)).status, 403);
});

test("a token without a role, or with an unknown role, returns 401", async () => {
  const noRole = jwt.sign({}, config.JWT_SECRET, { ...valid, expiresIn: 900 });
  const root = jwt.sign({ role: "ROOT" }, config.JWT_SECRET, { ...valid, expiresIn: 900 });

  for (const token of [noRole, root]) {
    const res = await api.get(PATH, bearer(token));
    assert.equal(res.status, 401);
  }
});

