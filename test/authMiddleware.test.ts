// authenticate() + the access checks, on test-only routes with a fake key lookup (no
// database). Every forged token or unknown key must end in 401, never in the handler.
import "./testEnv";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import { errorHandler } from "../src/app";
import { apiConfig } from "../src/config";
import { authenticate, getAuth, requireOwnAccount, requireOwnAccountOrProvider, requireProvider } from "../src/middleware/auth";
import { hashApiKey } from "../src/services/apiKeyService";
import { issueToken } from "../src/services/tokenService";
import { listen, type TestServer } from "./helpers";

let api: TestServer;

// The only active key the fake lookup knows (by hash, like the real table).
const PROVIDER_KEY = "pk_middleware-test-key-0123456789abcdef";
const KNOWN = new Map([[hashApiKey(PROVIDER_KEY), "usage-collector"]]);
const auth = authenticate(async (keyHash) => KNOWN.get(keyHash) ?? null);

before(async () => {
  const app = express();
  const who = (_req: express.Request, res: express.Response): void => {
    const id = getAuth(res);
    res.json({ ok: true, ...(id.kind === "provider" ? { provider: id.keyName } : { subscriberNo: id.subscriberNo }) });
  };
  app.get("/subscribers/:subscriberNo/private", auth, requireOwnAccount, who);
  app.get("/subscribers/:subscriberNo/support", auth, requireOwnAccountOrProvider, who);
  app.get("/subscribers/:subscriberNo/provider-only", auth, requireProvider, who);
  app.use(errorHandler);
  api = await listen(app);
});
after(() => api.close());

const PATH = "/subscribers/5551234/private";
const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const valid = { issuer: apiConfig().JWT_ISSUER, audience: apiConfig().JWT_AUDIENCE, subject: "5551234" };

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
  ["expired", () => jwt.sign({ exp: Math.floor(Date.now() / 1000) - 5 }, apiConfig().JWT_SECRET, valid)],
  ["for another audience", () => jwt.sign({}, apiConfig().JWT_SECRET, { ...valid, audience: "other-app", expiresIn: 900 })],
  ["from another issuer", () => jwt.sign({}, apiConfig().JWT_SECRET, { ...valid, issuer: "evil", expiresIn: 900 })],
  ["with no subject", () => jwt.sign({}, apiConfig().JWT_SECRET, { issuer: valid.issuer, audience: valid.audience, expiresIn: 900 })],
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

// ---------- subscriber vs provider (migration 007) ----------

const subscriberToken = (no: string): Record<string, string> => bearer(issueToken({ subscriberNo: no }).accessToken);
const providerKey = { "X-API-Key": PROVIDER_KEY };

test("own-or-provider: the own subscriber and the provider key pass, another subscriber gets 403", async () => {
  assert.equal((await api.get("/subscribers/5551234/support", subscriberToken("5551234"))).status, 200);
  assert.deepEqual(await (await api.get("/subscribers/5551234/support", providerKey)).json(), { ok: true, provider: "usage-collector" });
  assert.equal((await api.get("/subscribers/5551234/support", subscriberToken("5559999"))).status, 403);
});

test("provider-only: any subscriber gets 403, even for their own number", async () => {
  assert.equal((await api.get("/subscribers/5551234/provider-only", subscriberToken("5551234"))).status, 403);
  assert.equal((await api.get("/subscribers/5551234/provider-only", providerKey)).status, 200);
});

test("own-only: the provider key gets 403 (it can't act as the subscriber)", async () => {
  const res = await api.get(PATH, providerKey);

  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Only the subscriber can do this" });
});

test("an unknown or revoked key returns 401, and so does an empty one", async () => {
  for (const key of ["pk_not-a-real-key", ""]) {
    const res = await api.get("/subscribers/5551234/support", { "X-API-Key": key });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Invalid or revoked API key" });
  }
});

test("sending both a key and a token is refused (400): which one should count?", async () => {
  const res = await api.get("/subscribers/5551234/support", { ...providerKey, ...subscriberToken("5551234") });

  assert.equal(res.status, 400);
});
