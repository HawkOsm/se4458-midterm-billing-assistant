// On AWS only requests forwarded by the API Gateway (which adds the secret header) may reach
// the API; the load balancer's /health check still works without it.
import "./testEnv";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApp } from "../src/app";
import { GATEWAY_HEADER } from "../src/middleware/gatewayOnly";
import { beginTestTransaction, closePool, insertBill, listen, prepareTestDatabase } from "./helpers";

const SECRET = "gateway-test-secret-0123456789abcdefghij";
const BILL = "/api/v1/subscribers/5551234/bills/2025/4"; // Query Bill: public, so 200 once let in

before(prepareTestDatabase);
after(closePool);

async function withApp(gatewaySecret: string | undefined, run: (base: string) => Promise<void>): Promise<void> {
  const tx = await beginTestTransaction();
  await insertBill(tx.client);
  const server = await listen(createApp(tx.client, { gatewaySecret }));
  try {
    await run(server.base);
  } finally {
    await server.close();
    await tx.rollback();
  }
}

test("with a gateway secret, a request without the header gets 403", async () => {
  await withApp(SECRET, async (base) => {
    const res = await fetch(base + BILL);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Use the API Gateway URL" });
  });
});

test("with a gateway secret, a wrong header gets 403 (including one that is only a prefix)", async () => {
  await withApp(SECRET, async (base) => {
    for (const wrong of ["nope", SECRET.slice(0, -1), SECRET + "x", ""]) {
      const res = await fetch(base + BILL, { headers: { [GATEWAY_HEADER]: wrong } });
      assert.equal(res.status, 403, `header ${JSON.stringify(wrong)}`);
    }
  });
});

test("with the right header the request reaches the API", async () => {
  await withApp(SECRET, async (base) => {
    const res = await fetch(base + BILL, { headers: { [GATEWAY_HEADER]: SECRET } });
    assert.equal(res.status, 200);
  });
});

test("the gate also covers Swagger and unknown paths", async () => {
  await withApp(SECRET, async (base) => {
    for (const path of ["/api-docs/", "/openapi.json", "/nope"]) {
      assert.equal((await fetch(base + path)).status, 403, path);
    }
  });
});

test("/health answers without the header (the load balancer's check)", async () => {
  await withApp(SECRET, async (base) => {
    const res = await fetch(base + "/health");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });
});

test("without a gateway secret (local runs) every request is let through", async () => {
  await withApp(undefined, async (base) => {
    assert.equal((await fetch(base + BILL)).status, 200);
  });
});
