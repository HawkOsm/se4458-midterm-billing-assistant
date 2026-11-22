// PUT /api/v1/subscribers/{subscriberNo}/bills/{year}/{month}: Calculate Bill.
import "./testEnv";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { issueToken } from "../src/services/tokenService";
import {
  beginTestTransaction,
  closePool,
  insertSubscriber,
  insertUsageEvents,
  prepareTestDatabase,
  startTestServer,
  type TestServer,
  type TestTx,
} from "./helpers";

interface BillBody {
  subscriberNo: string;
  estimate: boolean;
  total: string;
  paidAmount: string;
  remainingBalance: string;
  status: string;
}
interface DetailsBody {
  calculatedAt: string;
  usage: { phoneMinutes: number; internetMb: number; internetGb: number };
  charges: { phone: { charge: string }; internet: { charge: string } };
  usageEvents: { total: number };
}

let tx: TestTx;
let api: TestServer;

before(prepareTestDatabase);
after(closePool);
beforeEach(async () => {
  tx = await beginTestTransaction();
  api = await startTestServer(tx.client);
  await insertSubscriber(tx.client, AYSE);
});
afterEach(async () => {
  await api.close();
  await tx.rollback();
});

const AYSE = "5551234";
const auth = (no: string): Record<string, string> => ({
  Authorization: `Bearer ${issueToken({ role: "SUBSCRIBER", subscriberNo: no }).accessToken}`,
});
const asAyse = auth(AYSE);
const billUrl = (year = 2025, month = 4, no = AYSE): string => `/api/v1/subscribers/${no}/bills/${year}/${month}`;

const phone = (count: number, month = 4): Promise<void> =>
  insertUsageEvents(tx.client, AYSE, { year: 2025, month, type: "PHONE", count }); // 10 min each
const internet = (count: number, month = 4): Promise<void> =>
  insertUsageEvents(tx.client, AYSE, { year: 2025, month, type: "INTERNET", count }); // 1 MB each

async function details(): Promise<DetailsBody> {
  return (await (await api.get(`${billUrl()}/details`, asAyse)).json()) as DetailsBody;
}

test("calculates the guide's worked example: 1,350 minutes + 35 GB = $80 (201)", async () => {
  await phone(135); // 1,350 minutes
  await internet(35_000); // 35,000 MB = 35 GB

  const res = await api.put(billUrl(), asAyse);
  const body = (await res.json()) as BillBody;

  assert.equal(res.status, 201);
  assert.equal(res.headers.get("location"), billUrl());
  assert.deepEqual(body, {
    subscriberNo: AYSE,
    year: 2025,
    month: 4,
    total: "80.00",
    paidAmount: "0.00",
    remainingBalance: "80.00",
    status: "UNPAID",
    estimate: false, // April 2025 is over
  });

  const d = await details();
  assert.deepEqual(d.usage, { phoneMinutes: 1350, internetMb: 35_000, internetGb: 35 });
  assert.equal(d.charges.phone.charge, "10.00");
  assert.equal(d.charges.internet.charge, "70.00");
  assert.equal(d.usageEvents.total, 135 + 35_000, "every counted event is linked to the bill");
});

test("a month with no usage still costs the $50 internet base (guide §3.1)", async () => {
  const res = await api.put(billUrl(), asAyse);

  assert.equal(res.status, 201);
  assert.equal(((await res.json()) as BillBody).total, "50.00");
});

test("the stored bill is what Query Bill then returns", async () => {
  await phone(101); // 1,010 minutes: one started extra block

  await api.put(billUrl(), asAyse);
  const res = await api.get(billUrl());

  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as BillBody).total, "60.00");
});

test("recalculating after more usage updates the same bill (200)", async () => {
  await phone(100); // 1,000 minutes: free
  const first = (await (await api.put(billUrl(), asAyse)).json()) as BillBody;
  await phone(1); // 1,010 minutes: one extra block

  const res = await api.put(billUrl(), asAyse);
  const second = (await res.json()) as BillBody;

  assert.equal(first.total, "50.00");
  assert.equal(res.status, 200);
  assert.equal(second.total, "60.00");
  const { rows } = await tx.client.query("SELECT count(*)::int AS n FROM billing.bills b JOIN billing.subscribers s ON s.id = b.subscriber_id WHERE s.subscriber_no = $1", [AYSE]);
  assert.equal(rows[0].n, 1, "still one bill for the month");
  assert.equal((await details()).usageEvents.total, 101);
});

test("recalculating with no new usage changes nothing, not even the issue date", async () => {
  await phone(10);
  await api.put(billUrl(), asAyse);
  await tx.client.query("UPDATE billing.bills SET calculated_at = '2025-05-01T00:00:00Z'"); // pretend it was issued earlier

  const res = await api.put(billUrl(), asAyse);

  assert.equal(res.status, 200);
  assert.equal((await details()).calculatedAt, "2025-05-01T00:00:00.000Z");
});

test("a bill with a payment is locked: 409 and unchanged", async () => {
  await api.put(billUrl(), asAyse); // $50
  await tx.client.query("UPDATE billing.bills SET paid_amount = 20, status = 'PARTIALLY_PAID'");
  await phone(200); // usage that would raise the bill

  const res = await api.put(billUrl(), asAyse);
  const after = (await (await api.get(billUrl())).json()) as BillBody;

  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), {
    error: "The 2025-04 bill already has payments and can no longer be recalculated",
  });
  assert.equal(after.total, "50.00");
  assert.equal(after.paidAmount, "20.00");
});

test("only this subscriber's usage for this month is counted", async () => {
  await phone(150, 4); // April: 1,500 minutes -> $10
  await phone(500, 5); // May: not part of April
  await insertSubscriber(tx.client, "5559999");
  await insertUsageEvents(tx.client, "5559999", { year: 2025, month: 4, type: "PHONE", count: 500 });

  const body = (await (await api.put(billUrl(), asAyse)).json()) as BillBody;

  assert.equal(body.total, "60.00");
  assert.equal((await details()).usageEvents.total, 150);
});

test("a month that hasn't started yet is refused with 400", async () => {
  const res = await api.put(billUrl(2100, 12), asAyse);

  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /^2100-12 has not started yet/);
});

test("the current, unfinished month can be calculated, and is marked as an estimate everywhere", async () => {
  const now = new Date();
  const [year, month] = [now.getUTCFullYear(), now.getUTCMonth() + 1];

  const calculated = await api.put(billUrl(year, month), asAyse);
  const queried = await api.get(billUrl(year, month));
  const detailed = await api.get(`${billUrl(year, month)}/details`, asAyse);

  assert.equal(calculated.status, 201);
  for (const res of [calculated, queried, detailed]) {
    assert.equal(((await res.json()) as { estimate: boolean }).estimate, true);
  }
});

test("without a token returns 401", async () => {
  assert.equal((await api.put(billUrl())).status, 401);
});

test("another subscriber's token returns 403", async () => {
  assert.equal((await api.put(billUrl(), auth("5559999"))).status, 403);
});

test("a valid token for a subscriber that doesn't exist returns 404", async () => {
  const res = await api.put(billUrl(2025, 4, "0000000"), auth("0000000"));

  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Unknown subscriber 0000000" });
});

test("invalid months are rejected with 400 before any work", async () => {
  assert.equal((await api.put(billUrl(2025, 13), asAyse)).status, 400);
});

// Rows of huge usage, written straight to the table (Add Usage caps each call at 10,000).
async function insertHugeInternet(rows: number, mbPerRow: number): Promise<void> {
  await tx.client.query(
    `INSERT INTO billing.usage_events (subscriber_id, period_year, period_month, usage_type, amount, idempotency_key)
     SELECT s.id, 2025, 4, 'INTERNET', $2, 'huge-' || g
       FROM billing.subscribers s, generate_series(1, $1::int) g WHERE s.subscriber_no = $3`,
    [rows, mbPerRow, AYSE],
  );
}

test("a month above the old INTEGER limit (2,147,483,647 MB) still bills (BIGINT, migration 005)", async () => {
  await insertHugeInternet(3, 1_000_000_000); // 3,000,000,000 MB

  const res = await api.put(billUrl(), asAyse);

  assert.equal(res.status, 201);
  assert.equal(((await res.json()) as BillBody).total, "3000030.00"); // $50 + 299,998 blocks x $10
});

test("usage too large to bill is refused with 422 and nothing is linked", async () => {
  await insertHugeInternet(60, 2_000_000_000); // 120 billion MB: charge > 99,999,999.99

  const res = await api.put(billUrl(), asAyse);

  assert.equal(res.status, 422);
  assert.match(((await res.json()) as { error: string }).error, /too large to bill/);
  const { rows } = await tx.client.query("SELECT count(*)::int AS n FROM billing.usage_events WHERE bill_id IS NOT NULL");
  assert.equal(rows[0].n, 0, "the transaction was rolled back");
  assert.equal((await api.get(billUrl())).status, 404, "no bill was stored");
});

test("the provider's admin can calculate any subscriber's bill", async () => {
  const admin = { Authorization: `Bearer ${issueToken({ role: "ADMIN", username: "admin" }).accessToken}` };

  const res = await api.put(billUrl(), admin);

  assert.equal(res.status, 201);
});

