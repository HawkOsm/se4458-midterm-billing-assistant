// The public dev signing key from .env.example must never protect a deployed database.
import "./testEnv";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseEnv } from "node:util";
import { PUBLIC_DEV_SECRET_PREFIX, parseConfig } from "../src/config";

const DEV_KEY = `${PUBLIC_DEV_SECRET_PREFIX}public-key-do-not-deploy-test`;
const PRIVATE_KEY = "a-private-random-key-0123456789abcdef";
const RDS_HOST = "billing.abc123.eu-north-1.rds.amazonaws.com";

test("the public dev key is accepted with a local database", () => {
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    assert.equal(parseConfig({ JWT_SECRET: DEV_KEY, POSTGRES_HOST: host }).JWT_SECRET, DEV_KEY);
  }
});

test("the public dev key is refused with a remote database", () => {
  assert.throws(
    () => parseConfig({ JWT_SECRET: DEV_KEY, POSTGRES_HOST: RDS_HOST }),
    /Refusing to start: JWT_SECRET is the public development key/,
  );
});

test("a private key works with a remote database", () => {
  assert.equal(parseConfig({ JWT_SECRET: PRIVATE_KEY, POSTGRES_HOST: RDS_HOST }).POSTGRES_HOST, RDS_HOST);
});

test("a missing or short secret is refused everywhere", () => {
  assert.throws(() => parseConfig({}), /JWT_SECRET/);
  assert.throws(() => parseConfig({ JWT_SECRET: "too-short" }), /at least 32 characters/);
});

test(".env.example's key is marked as the public dev key, so the guard covers it", () => {
  const template = parseEnv(readFileSync(".env.example", "utf8"));
  const key = template["JWT_SECRET"] ?? "";

  assert.ok(key.startsWith(PUBLIC_DEV_SECRET_PREFIX), `template JWT_SECRET must start with ${PUBLIC_DEV_SECRET_PREFIX}`);
  assert.ok(key.length >= 32);
});
