// requireAuth + requireOwnAccount, tested on a test-only route so no real endpoint
// is needed yet. Every forged-token case must end in 401, never in the handler.
import "./testEnv";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import { errorHandler } from "../src/app";
import { config } from "../src/config";
import { getAuth, requireAuth, requireOwnAccount } from "../src/middleware/auth";
import { issueToken } from "../src/services/tokenService";
import { listen, type TestServer } from "./helpers";

let api: TestServer;

before(async () => {
  const app = express();
  app.get("/subscribers/:subscriberNo/private", requireAuth, requireOwnAccount, (_req, res) => {
    res.json({ ok: true, subscriberNo: getAuth(res).subscriberNo });
  });
  app.use(errorHandler);
  api = await listen(app);
});
after(() => api.close());

const PATH = "/subscribers/5551234/private";
const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const valid = { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE, subject: "5551234" };

test("a valid token for the same subscriber gets through", async () => {
  const { accessToken } = issueToken({ subscriberNo: "5551234" });

  const res = await api.get(PATH, bearer(accessToken));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, subscriberNo: "5551234" });
});

test("a valid token for another subscriber is refused with 403", async () => {
  const { accessToken } = issueToken({ subscriberNo: "5559999" });

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
  ["signed with another secret", () => jwt.sign({}, "x".repeat(40), { ...valid, expiresIn: 900 })],
  ["expired", () => jwt.sign({ exp: Math.floor(Date.now() / 1000) - 5 }, config.JWT_SECRET, valid)],
  ["for another audience", () => jwt.sign({}, config.JWT_SECRET, { ...valid, audience: "other-app", expiresIn: 900 })],
  ["from another issuer", () => jwt.sign({}, config.JWT_SECRET, { ...valid, issuer: "evil", expiresIn: 900 })],
  ["with no subject", () => jwt.sign({}, config.JWT_SECRET, { issuer: valid.issuer, audience: valid.audience, expiresIn: 900 })],
  ["using alg none (unsigned)", () => {
    const part = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    return `${part({ alg: "none", typ: "JWT" })}.${part({ sub: "5551234", iss: valid.issuer, aud: valid.audience, exp: now + 900 })}.`;
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
  const { accessToken } = issueToken({ subscriberNo: "5551234" });

  const res = await api.get(PATH, { Authorization: `Basic ${accessToken}` });

  assert.equal(res.status, 401);
});
