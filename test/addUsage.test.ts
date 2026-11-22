// POST /api/v1/subscribers/{subscriberNo}/usage: Add Usage.
import "./testEnv";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { issueToken } from "../src/services/tokenService";
import { UsageService } from "../src/services/usageService";
import {
  beginTestTransaction,
  closePool,
  PROVIDER_HEADERS,
  insertApiKey,
  insertBill,
  insertSubscriber,
  prepareTestDatabase,
  startTestServer,
  type TestServer,
  type TestTx,
} from "./helpers";

interface UsageBody {
  status: string;
  subscriberNo: string;
  year: number;
  month: number;
  usageType: string;
  quantity: number;
  amount: number;
  unit: string;
  recordedAt: string;
}

let tx: TestTx;
let api: TestServer;

const AYSE = "5551234";
const token = (no: string): string => `Bearer ${issueToken({ subscriberNo: no }).accessToken}`;
// Usage is recorded by the provider's systems (API key), never by the customer.
const url = (no = AYSE): string => `/api/v1/subscribers/${no}/usage`;

before(prepareTestDatabase);
after(closePool);
beforeEach(async () => {
  tx = await beginTestTransaction();
  api = await startTestServer(tx.client);
  await insertSubscriber(tx.client, AYSE);
  await insertApiKey(tx.client);
});
afterEach(async () => {
  await api.close();
  await tx.rollback();
});

// POST with the provider's API key for subscriber `no`, and the given Idempotency-Key.
function addUsage(body: unknown, key: string | null = randomUUID(), no = AYSE): Promise<Response> {
  const headers: Record<string, string> = { ...PROVIDER_HEADERS };
  if (key !== null) headers["Idempotency-Key"] = key;
  return api.postJson(url(no), body, headers);
}

async function countEvents(no = AYSE): Promise<number> {
  const { rows } = await tx.client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM billing.usage_events e
       JOIN billing.subscribers s ON s.id = e.subscriber_id WHERE s.subscriber_no = $1`,
    [no],
  );
  return rows[0]!.n;
}

const april = { year: 2025, month: 4 };

test("one PHONE unit records 10 minutes (the spec's default call)", async () => {
  const res = await addUsage({ ...april, usageType: "PHONE" });
  const body = (await res.json()) as UsageBody;

  assert.equal(res.status, 201);
  assert.equal(res.headers.get("idempotent-replayed"), null);
  assert.deepEqual({ ...body, recordedAt: "<time>" }, {
    status: "RECORDED",
    subscriberNo: AYSE,
    year: 2025,
    month: 4,
    usageType: "PHONE",
    quantity: 1,
    amount: 10,
    unit: "minutes",
    recordedAt: "<time>",
  });
  assert.equal(await countEvents(), 1);
});

test("an INTERNET report with quantity 50 records 50 MB as ONE event", async () => {
  const body = (await (await addUsage({ ...april, usageType: "INTERNET", quantity: 50 })).json()) as UsageBody;

  assert.equal(body.amount, 50);
  assert.equal(body.unit, "MB");
  assert.equal(body.quantity, 50);
  assert.equal(await countEvents(), 1);
});

test("a retry with the same key replays the original and records nothing new", async () => {
  const key = randomUUID();
  const first = await addUsage({ ...april, usageType: "PHONE", quantity: 3 }, key);
  const retry = await addUsage({ ...april, usageType: "PHONE", quantity: 3 }, key);

  assert.equal(retry.status, 201);
  assert.equal(retry.headers.get("idempotent-replayed"), "true");
  assert.deepEqual(await retry.json(), await first.json(), "same body, including recordedAt");
  assert.equal(await countEvents(), 1);
});

test("reusing a key for a different report is refused with 409", async () => {
  const key = randomUUID();
  await addUsage({ ...april, usageType: "PHONE", quantity: 3 }, key);

  for (const changed of [
    { ...april, usageType: "PHONE", quantity: 4 },
    { ...april, usageType: "INTERNET", quantity: 3 },
    { year: 2025, month: 5, usageType: "PHONE", quantity: 3 },
  ]) {
    const res = await addUsage(changed, key);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "This Idempotency-Key was already used for a different usage report" });
  }
  assert.equal(await countEvents(), 1);
});

test("keys are per subscriber: another subscriber may use the same key", async () => {
  await insertSubscriber(tx.client, "5559999");
  const key = randomUUID();

  const ayse = await addUsage({ ...april, usageType: "PHONE" }, key);
  const mehmet = await addUsage({ ...april, usageType: "PHONE" }, key, "5559999");

  assert.equal(ayse.status, 201);
  assert.equal(mehmet.status, 201);
  assert.equal(mehmet.headers.get("idempotent-replayed"), null);
});

test("a missing Idempotency-Key is refused with 400", async () => {
  const res = await addUsage({ ...april, usageType: "PHONE" }, null);

  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /^idempotency-key: /);
  assert.equal(await countEvents(), 0);
});

test("a key longer than 100 characters is refused with 400", async () => {
  assert.equal((await addUsage({ ...april, usageType: "PHONE" }, "k".repeat(101))).status, 400);
});

for (const [name, body, field] of [
  ["quantity 0", { ...april, usageType: "PHONE", quantity: 0 }, "quantity"],
  ["quantity above 10,000", { ...april, usageType: "PHONE", quantity: 10_001 }, "quantity"],
  ["fractional quantity", { ...april, usageType: "INTERNET", quantity: 1.5 }, "quantity"],
  ["an unknown usage type", { ...april, usageType: "SMS" }, "usageType"],
  ["month 13", { year: 2025, month: 13, usageType: "PHONE" }, "month"],
  ["a missing year", { month: 4, usageType: "PHONE" }, "year"],
] as const) {
  test(`${name} is refused with 400 naming ${field}`, async () => {
    const res = await addUsage(body);

    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, new RegExp(`^${field}: `));
  });
}

test("a month that hasn't started yet is refused with 400", async () => {
  const res = await addUsage({ year: 2100, month: 12, usageType: "PHONE" });

  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /^2100-12 has not started yet/);
});

test("usage for a month whose bill has a payment is refused with 409", async () => {
  await insertBill(tx.client, { subscriberNo: AYSE, paidAmount: "10.00", status: "PARTIALLY_PAID" });

  const res = await addUsage({ ...april, usageType: "PHONE" });

  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "The 2025-04 bill already has payments; usage can no longer be added to it" });
  assert.equal(await countEvents(), 0);
});

test("usage for a month with an unpaid bill is accepted (billed at the next recalculation)", async () => {
  await insertBill(tx.client, { subscriberNo: AYSE });

  assert.equal((await addUsage({ ...april, usageType: "PHONE" })).status, 201);
});

test("a retry is still replayed after the bill got paid", async () => {
  const key = randomUUID();
  await addUsage({ ...april, usageType: "PHONE" }, key);
  await insertBill(tx.client, { subscriberNo: AYSE, paidAmount: "10.00", status: "PARTIALLY_PAID" });

  const retry = await addUsage({ ...april, usageType: "PHONE" }, key);

  assert.equal(retry.status, 201);
  assert.equal(retry.headers.get("idempotent-replayed"), "true");
});

test("end to end: reported usage is what Calculate Bill charges", async () => {
  await addUsage({ ...april, usageType: "PHONE", quantity: 135 }); // 1,350 minutes
  await addUsage({ ...april, usageType: "INTERNET", quantity: 10_000 });
  await addUsage({ ...april, usageType: "INTERNET", quantity: 10_000 });
  await addUsage({ ...april, usageType: "INTERNET", quantity: 10_000 });
  await addUsage({ ...april, usageType: "INTERNET", quantity: 5_000 }); // 35,000 MB in total

  const bill = await api.put(`/api/v1/subscribers/${AYSE}/bills/2025/4`, { Authorization: token(AYSE) });

  assert.equal(bill.status, 201);
  assert.equal(((await bill.json()) as { total: string }).total, "80.00"); // guide §4.3
});

test("without a token returns 401", async () => {
  const res = await api.postJson(url(), { ...april, usageType: "PHONE" }, { "Idempotency-Key": randomUUID() });

  assert.equal(res.status, 401);
});

test("a subscriber can't record usage, not even their own (403): only the provider's systems can", async () => {
  for (const auth of [token(AYSE), token("5559999")]) {
    const res = await api.postJson(url(), { ...april, usageType: "PHONE" }, {
      Authorization: auth,
      "Idempotency-Key": randomUUID(),
    });

    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Only the provider's systems can do this (X-API-Key)" });
  }
  assert.equal(await countEvents(), 0);
});

test("the provider recording usage for a subscriber that doesn't exist gets 404", async () => {
  const res = await addUsage({ ...april, usageType: "PHONE" }, randomUUID(), "0000000");

  assert.equal(res.status, 404);
});

test("a retry is replayed even where the clock still says an earlier month", async () => {
  const service = new UsageService(tx.client);
  const report = { year: 2026, month: 12, usageType: "PHONE" as const, quantity: 1 };
  const dec1 = new Date("2026-12-01T00:00:01Z");
  const nov30 = new Date("2026-11-30T23:59:59Z"); // another server, clock slightly behind

  const first = await service.add(AYSE, report, "boundary-key", dec1);
  const retry = await service.add(AYSE, report, "boundary-key", nov30);

  assert.equal(first.kind, "recorded");
  assert.deepEqual(retry.kind === "recorded" && retry.replayed, true);
});

test("a revoked provider key is refused (401) by the real key lookup", async () => {
  await tx.client.query("UPDATE billing.api_keys SET revoked_at = now()");

  const res = await addUsage({ ...april, usageType: "PHONE" });

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Invalid or revoked API key" });
  assert.equal(await countEvents(), 0);
});
