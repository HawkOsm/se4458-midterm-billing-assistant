// GET /api/v1/subscribers/{subscriberNo}/bills/{year}/{month}/details: Query Bill Detailed.
import "./testEnv";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { issueToken } from "../src/services/tokenService";
import {
  PROVIDER_HEADERS,
  beginTestTransaction,
  closePool,
  insertApiKey,
  insertBill,
  insertUsageEvents,
  prepareTestDatabase,
  startTestServer,
  type TestServer,
  type TestTx,
} from "./helpers";

interface Details {
  total: string;
  tariffId: string;
  remainingBalance: string;
  usage: { phoneMinutes: number; internetMb: number; internetGb: number };
  charges: {
    phone: { extraBlocks: number; charge: string };
    internet: { baseCharge: string; extraBlocks: number; charge: string };
  };
  usageEvents: {
    items: { type: string; amount: number; unit: string; recordedAt: string }[];
    offset: number;
    limit: number;
    total: number;
  };
}

let tx: TestTx;
let api: TestServer;

before(prepareTestDatabase);
after(closePool);
beforeEach(async () => {
  tx = await beginTestTransaction();
  api = await startTestServer(tx.client);
});
afterEach(async () => {
  await api.close();
  await tx.rollback();
});

const AYSE = "5551234";
const asAyse = { Authorization: `Bearer ${issueToken({ subscriberNo: AYSE }).accessToken}` };
const url = (query = "", no = AYSE): string => `/api/v1/subscribers/${no}/bills/2025/4/details${query}`;

// The guide's worked example (§4.3): 1,350 minutes + 35 GB = $10 + $70 = $80.
async function insertWorkedExampleBill(): Promise<number> {
  return insertBill(tx.client, {
    subscriberNo: AYSE,
    phoneMinutes: 1350,
    internetMb: 35_000,
    phoneCharge: "10.00",
    internetCharge: "70.00",
  });
}

test("returns the charge breakdown of the guide's worked example", async () => {
  await insertWorkedExampleBill();

  const res = await api.get(url(), asAyse);
  const body = (await res.json()) as Details;

  assert.equal(res.status, 200);
  assert.equal(body.total, "80.00");
  assert.equal(body.remainingBalance, "80.00");
  assert.deepEqual(body.usage, { phoneMinutes: 1350, internetMb: 35_000, internetGb: 35 });
  assert.equal(body.charges.phone.extraBlocks, 1);
  assert.equal(body.charges.phone.charge, "10.00");
  assert.equal(body.charges.internet.baseCharge, "50.00");
  assert.equal(body.charges.internet.extraBlocks, 2);
  assert.equal(body.charges.internet.charge, "70.00");
  assert.equal(body.tariffId, "MOB-BILLING-2026-01");
});

test("pages usage events newest first with offset and limit", async () => {
  const billId = await insertWorkedExampleBill();
  await insertUsageEvents(tx.client, AYSE, { year: 2025, month: 4, type: "PHONE", count: 25, billId });

  const first = (await (await api.get(url("?limit=10"), asAyse)).json()) as Details;
  const last = (await (await api.get(url("?offset=20&limit=10"), asAyse)).json()) as Details;

  assert.equal(first.usageEvents.total, 25);
  assert.equal(first.usageEvents.items.length, 10);
  assert.equal(last.usageEvents.items.length, 5); // 25 = 10 + 10 + 5
  assert.equal(last.usageEvents.offset, 20);

  const times = first.usageEvents.items.map((e) => Date.parse(e.recordedAt));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), "newest first");
  assert.ok(Date.parse(first.usageEvents.items[9]!.recordedAt) > Date.parse(last.usageEvents.items[0]!.recordedAt));
  assert.deepEqual(first.usageEvents.items[0], {
    type: "PHONE",
    amount: 10,
    unit: "minutes",
    recordedAt: first.usageEvents.items[0]!.recordedAt,
  });
});

test("defaults to offset 0 and limit 20", async () => {
  const billId = await insertWorkedExampleBill();
  await insertUsageEvents(tx.client, AYSE, { year: 2025, month: 4, type: "INTERNET", count: 30, billId });

  const body = (await (await api.get(url(), asAyse)).json()) as Details;

  assert.equal(body.usageEvents.offset, 0);
  assert.equal(body.usageEvents.limit, 20);
  assert.equal(body.usageEvents.items.length, 20);
  assert.equal(body.usageEvents.items[0]!.unit, "MB");
});

test("an offset past the end returns an empty page with the real total", async () => {
  const billId = await insertWorkedExampleBill();
  await insertUsageEvents(tx.client, AYSE, { year: 2025, month: 4, type: "PHONE", count: 3, billId });

  const body = (await (await api.get(url("?offset=50"), asAyse)).json()) as Details;

  assert.deepEqual(body.usageEvents.items, []);
  assert.equal(body.usageEvents.total, 3);
});

test("lists only the events the bill counted, not unbilled usage of the same month", async () => {
  const billId = await insertWorkedExampleBill();
  await insertUsageEvents(tx.client, AYSE, { year: 2025, month: 4, type: "PHONE", count: 4, billId });
  // Same period, recorded EARLIER than the counted ones but not linked: a timestamp
  // filter would have listed these; the bill_id link doesn't.
  await insertUsageEvents(tx.client, AYSE, { year: 2025, month: 4, type: "INTERNET", count: 2, endSecondsFromNow: -60 });
  await insertUsageEvents(tx.client, AYSE, { year: 2025, month: 5, type: "PHONE", count: 7 }); // other month

  const body = (await (await api.get(url(), asAyse)).json()) as Details;

  assert.equal(body.usageEvents.total, 4);
  assert.ok(body.usageEvents.items.every((e) => e.type === "PHONE"));
});

test("without a token returns 401", async () => {
  await insertWorkedExampleBill();

  const res = await api.get(url());

  assert.equal(res.status, 401);
});

test("another subscriber's token returns 403, even though the bill exists", async () => {
  await insertWorkedExampleBill();
  const asMehmet = { Authorization: `Bearer ${issueToken({ subscriberNo: "5559999" }).accessToken}` };

  const res = await api.get(url(), asMehmet);

  assert.equal(res.status, 403);
});

test("no stored bill for the period returns 404", async () => {
  const res = await api.get(url(), asAyse);

  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "No bill for 5551234 in 2025-04" });
});

for (const [query, field] of [
  ["?limit=0", "limit"],
  ["?limit=101", "limit"],
  ["?limit=ten", "limit"],
  ["?offset=-1", "offset"],
  ["?offset=1.5", "offset"],
] as const) {
  test(`rejects ${query} with 400 naming the ${field}`, async () => {
    await insertWorkedExampleBill();

    const res = await api.get(url(query), asAyse);
    const body = (await res.json()) as { error: string };

    assert.equal(res.status, 400);
    assert.match(body.error, new RegExp(`^${field}: `));
  });
}

test("the provider's key can read any subscriber's detailed bill", async () => {
  await insertWorkedExampleBill();
  await insertApiKey(tx.client);
  const admin = PROVIDER_HEADERS;

  const res = await api.get(url(), admin);

  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as Details).total, "80.00");
});

