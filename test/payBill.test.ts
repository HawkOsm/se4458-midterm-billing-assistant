// POST /api/v1/subscribers/{subscriberNo}/bills/{year}/{month}/payments: Pay Bill.
import "./testEnv";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { issueToken } from "../src/services/tokenService";
import {
  beginTestTransaction,
  closePool,
  insertBill,
  insertUsageEvents,
  prepareTestDatabase,
  startTestServer,
  type TestServer,
  type TestTx,
} from "./helpers";

interface PaymentBody {
  paymentStatus: string;
  transactionId: string;
  amount: string;
  paidAmount: string;
  remainingBalance: string;
  billStatus: string;
}
interface BillBody {
  total: string;
  paidAmount: string;
  remainingBalance: string;
  status: string;
}

let tx: TestTx;
let api: TestServer;

const AYSE = "5551234";
const token = (no: string): string => `Bearer ${issueToken({ role: "SUBSCRIBER", subscriberNo: no }).accessToken}`;
const billUrl = (no = AYSE, year = 2025, month = 4): string => `/api/v1/subscribers/${no}/bills/${year}/${month}`;

before(prepareTestDatabase);
after(closePool);
beforeEach(async () => {
  tx = await beginTestTransaction();
  api = await startTestServer(tx.client);
  // April 2025: the guide's worked example, $10 phone + $70 internet = $80.
  await insertBill(tx.client, { subscriberNo: AYSE, phoneCharge: "10.00", internetCharge: "70.00" });
});
afterEach(async () => {
  await api.close();
  await tx.rollback();
});

function pay(amount: unknown, transactionId: string = randomUUID(), no = AYSE, month = 4): Promise<Response> {
  return api.postJson(`${billUrl(no, 2025, month)}/payments`, { transactionId, amount }, { Authorization: token(no) });
}

async function bill(no = AYSE): Promise<BillBody> {
  return (await (await api.get(billUrl(no))).json()) as BillBody;
}

async function paymentCount(): Promise<number> {
  const { rows } = await tx.client.query<{ n: number }>("SELECT count(*)::int AS n FROM billing.payments");
  return rows[0]!.n;
}

test("a partial payment reduces the balance but doesn't mark the bill paid (guide §5.1)", async () => {
  const res = await pay("25.00", "tx-partial");
  const body = (await res.json()) as PaymentBody;

  assert.equal(res.status, 201);
  assert.deepEqual(body, {
    paymentStatus: "ACCEPTED",
    transactionId: "tx-partial",
    subscriberNo: AYSE,
    year: 2025,
    month: 4,
    amount: "25.00",
    paidAmount: "25.00",
    remainingBalance: "55.00",
    billStatus: "PARTIALLY_PAID",
  });
  const after = await bill();
  assert.equal(after.total, "80.00");
  assert.equal(after.paidAmount, "25.00");
  assert.equal(after.remainingBalance, "55.00");
  assert.equal(after.status, "PARTIALLY_PAID");
});

test("paying the rest marks the bill PAID", async () => {
  await pay("30.00");
  const body = (await (await pay(50)).json()) as PaymentBody;

  assert.equal(body.remainingBalance, "0.00");
  assert.equal(body.billStatus, "PAID");
  assert.equal((await bill()).status, "PAID");
});

test("paying more than the remaining balance is refused with 422 and changes nothing", async () => {
  await pay("70.00");

  const res = await pay("10.01");

  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: "Amount 10.01 exceeds the remaining balance 10.00" });
  assert.equal((await bill()).paidAmount, "70.00");
  assert.equal(await paymentCount(), 1);
});

test("a fully paid bill refuses further payments with 422", async () => {
  await pay("80.00");

  const res = await pay("1.00");

  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: "The 2025-04 bill is already fully paid" });
});

test("amounts are accepted as text or number, at most 2 decimals", async () => {
  assert.equal((await pay("10.5")).status, 201);
  assert.equal((await pay(10.25)).status, 201);
  assert.equal((await bill()).paidAmount, "20.75");
});

for (const [name, amount] of [
  ["zero", "0"],
  ["negative", -5],
  ["three decimals", "10.123"],
  ["text", "ten"],
  ["a float that isn't 2 decimals (0.1 + 0.2)", 0.1 + 0.2],
  ["missing", undefined],
] as const) {
  test(`an amount that is ${name} is refused with 400`, async () => {
    const res = await pay(amount);

    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /^amount: /);
    assert.equal(await paymentCount(), 0);
  });
}

test("a retry with the same transactionId replays the original and pays nothing again", async () => {
  const first = await pay("25.00", "tx-retry");
  await pay("5.00"); // another payment in between
  const retry = await pay("25.00", "tx-retry");

  assert.equal(retry.status, 201);
  assert.equal(retry.headers.get("idempotent-replayed"), "true");
  assert.deepEqual(await retry.json(), await first.json(), "same snapshot: remaining 55.00, not 50.00");
  assert.equal((await bill()).paidAmount, "30.00");
  assert.equal(await paymentCount(), 2);
});

test("reusing a transactionId for a different payment is refused with 409", async () => {
  await pay("25.00", "tx-used");
  await insertBill(tx.client, { subscriberNo: AYSE, month: 5 });

  for (const res of [await pay("26.00", "tx-used"), await pay("25.00", "tx-used", AYSE, 5)]) {
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "This transactionId was already used for a different payment" });
  }
  assert.equal(await paymentCount(), 1);
});

test("another subscriber can't reuse (or replay) someone's transactionId", async () => {
  await pay("25.00", "tx-ayse");
  await insertBill(tx.client, { subscriberNo: "5559999" });

  const res = await pay("25.00", "tx-ayse", "5559999");

  assert.equal(res.status, 409);
});

test("a month without a calculated bill is refused with 404", async () => {
  const res = await pay("10.00", randomUUID(), AYSE, 3);

  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "No bill for 5551234 in 2025-03; calculate the bill first" });
});

test("usage added after the calculation must be billed before paying (409, then OK)", async () => {
  await insertUsageEvents(tx.client, AYSE, { year: 2025, month: 4, type: "PHONE", count: 5 }); // unbilled

  const refused = await pay("10.00");
  await api.put(billUrl(), { Authorization: token(AYSE) }); // recalculate: links the usage
  const accepted = await pay("10.00");

  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /recalculate the bill/);
  assert.equal(accepted.status, 201);
});

test("after a payment the month is locked for recalculation and new usage", async () => {
  await pay("10.00");

  const recalc = await api.put(billUrl(), { Authorization: token(AYSE) });
  const usage = await api.postJson(
    `/api/v1/subscribers/${AYSE}/usage`,
    { year: 2025, month: 4, usageType: "PHONE" },
    { Authorization: `Bearer ${issueToken({ role: "ADMIN", username: "admin" }).accessToken}`, "Idempotency-Key": randomUUID() },
  );

  assert.equal(recalc.status, 409);
  assert.equal(usage.status, 409);
});

test("the provider's admin can't pay for a subscriber (403)", async () => {
  const res = await api.postJson(`${billUrl()}/payments`, { transactionId: randomUUID(), amount: "10.00" }, {
    Authorization: `Bearer ${issueToken({ role: "ADMIN", username: "admin" }).accessToken}`,
  });

  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Only the subscriber can do this, not an admin" });
  assert.equal(await paymentCount(), 0);
});

test("the stored payment keeps the result snapshot for replays", async () => {
  await pay("25.00", "tx-snap");

  const { rows } = await tx.client.query(
    "SELECT amount::text, paid_amount_after::text, remaining_after::text, status_after FROM billing.payments WHERE transaction_id = 'tx-snap'",
  );
  assert.deepEqual(rows[0], { amount: "25.00", paid_amount_after: "25.00", remaining_after: "55.00", status_after: "PARTIALLY_PAID" });
});

test("a missing transactionId is refused with 400", async () => {
  const res = await api.postJson(`${billUrl()}/payments`, { amount: "10.00" }, { Authorization: token(AYSE) });

  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /^transactionId: /);
});

test("without a token returns 401", async () => {
  assert.equal((await api.postJson(`${billUrl()}/payments`, { transactionId: "t", amount: "1.00" })).status, 401);
});

test("another subscriber's token returns 403 and pays nothing", async () => {
  const res = await api.postJson(`${billUrl()}/payments`, { transactionId: "t", amount: "1.00" }, { Authorization: token("5559999") });

  assert.equal(res.status, 403);
  assert.equal(await paymentCount(), 0);
});

test("a valid token for a subscriber that doesn't exist returns 404", async () => {
  assert.equal((await pay("1.00", randomUUID(), "0000000")).status, 404);
});

test("the current, unfinished month can't be paid yet (409): paying would lock its usage", async () => {
  const now = new Date();
  const [year, month] = [now.getUTCFullYear(), now.getUTCMonth() + 1];
  await insertBill(tx.client, { subscriberNo: AYSE, year, month });

  const res = await api.postJson(`${billUrl(AYSE, year, month)}/payments`, { transactionId: randomUUID(), amount: "10.00" }, {
    Authorization: token(AYSE),
  });

  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /is not over yet/);
});
