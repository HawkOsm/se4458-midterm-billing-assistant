// Swagger must describe exactly what the app serves. If a documented path isn't routed
// (e.g. the version prefix changed in one place but not another), "Try it out" breaks
// silently; this test catches it.
import "./testEnv";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { OPENAPI_FILE } from "../scripts/export-openapi";
import { createApp } from "../src/app";
import {
  beginTestTransaction,
  closePool,
  listen,
  prepareTestDatabase,
  type TestServer,
  type TestTx,
} from "./helpers";

interface OpenApiDoc {
  paths: Record<string, Record<string, unknown>>;
}

let tx: TestTx;
let api: TestServer;

before(prepareTestDatabase);
after(closePool);
beforeEach(async () => {
  tx = await beginTestTransaction();
  api = await listen(createApp(tx.client));
});
afterEach(async () => {
  await api.close();
  await tx.rollback();
});

async function documentedRoutes(): Promise<{ method: string; path: string }[]> {
  const doc = (await (await api.get("/openapi.json")).json()) as OpenApiDoc;
  return Object.entries(doc.paths).flatMap(([path, ops]) =>
    Object.keys(ops).map((method) => ({ method, path })),
  );
}

test("every documented route is versioned under /api/v1", async () => {
  const routes = await documentedRoutes();

  assert.ok(routes.length >= 2);
  for (const { path } of routes) assert.match(path, /^\/api\/v1\//);
});

test("every documented route is actually served by the app", async () => {
  for (const { method, path } of await documentedRoutes()) {
    const url = path.replace(/\{\w+\}/g, "1"); // placeholder for each path parameter
    // Each documented method is sent as itself; any body: we only care that a route answers.
    const res =
      method === "get" ? await api.get(url) : method === "put" ? await api.put(url) : await api.postJson(url, {});
    const body = (await res.json()) as { error?: string };

    // The app's catch-all 404 means "no such route". Anything else (200, 400, 401,
    // or a route's own 404 such as "No bill for ...") proves the route exists.
    assert.notEqual(body.error, "Not found", `${method.toUpperCase()} ${path} is documented but not routed`);
  }
});

test("building the app twice doesn't duplicate Swagger entries", async () => {
  const first = await documentedRoutes();
  const second = await listen(createApp(tx.client));
  try {
    const doc = (await (await second.get("/openapi.json")).json()) as OpenApiDoc;
    const count = Object.values(doc.paths).reduce((n, ops) => n + Object.keys(ops).length, 0);
    assert.equal(count, first.length);
  } finally {
    await second.close();
  }
});

test("docs/openapi.json is the spec the app serves (run `npm run openapi` after changing routes)", async () => {
  const served: unknown = await (await api.get("/openapi.json")).json();
  assert.deepEqual(JSON.parse(readFileSync(OPENAPI_FILE, "utf8")), served);
});
