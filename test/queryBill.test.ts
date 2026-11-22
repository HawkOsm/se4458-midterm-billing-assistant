// GET /api/v1/subscribers/{subscriberNo}/bills/{year}/{month}: Query Bill.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import {
  beginTestTransaction,
  closePool,
  insertBill,
  prepareTestDatabase,
  startTestServer,
  type TestServer,
  type TestTx,
} from "./helpers";

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

const url = (no: string, year: number | string, month: number | string): string =>
  `/api/v1/subscribers/${no}/bills/${year}/${month}`;

test("returns the stored bill with its remaining balance", async () => {
  await insertBill(tx.client, { paidAmount: "25.00", status: "PARTIALLY_PAID" });

  const res = await api.get(url("5551234", 2025, 4));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    subscriberNo: "5551234",
    year: 2025,
    month: 4,
    total: "75.00",
    paidAmount: "25.00",
    remainingBalance: "50.00",
    status: "PARTIALLY_PAID",
  });
});

test("returns 404 when no bill was calculated for that month", async () => {
  await insertBill(tx.client, { month: 4 }); // a bill exists, but not for May

  const res = await api.get(url("5551234", 2025, 5));

  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "No bill for 5551234 in 2025-05" });
});

test("returns 404 for an unknown subscriber", async () => {
  const res = await api.get(url("0000000", 2025, 4));

  assert.equal(res.status, 404);
});

test("does not return another subscriber's bill", async () => {
  await insertBill(tx.client, { subscriberNo: "5551234" });
  await insertBill(tx.client, { subscriberNo: "5559999", phoneCharge: "0.00" });

  const res = await api.get(url("5559999", 2025, 4));
  const body = (await res.json()) as { subscriberNo: string; total: string };

  assert.equal(res.status, 200);
  assert.equal(body.subscriberNo, "5559999");
  assert.equal(body.total, "50.00");
});

for (const [year, month, field] of [
  [2025, 0, "month"],
  [2025, 13, "month"],
  [1999, 4, "year"],
  [2025, "april", "month"],
  [2025, "4.5", "month"],
] as const) {
  test(`rejects year=${year} month=${month} with 400 naming the ${field}`, async () => {
    const res = await api.get(url("5551234", year, month));
    const body = (await res.json()) as { error: string };

    assert.equal(res.status, 400);
    assert.match(body.error, new RegExp(`^${field}: `));
  });
}

test("rejects a subscriber number longer than 20 characters with 400", async () => {
  const res = await api.get(url("1".repeat(21), 2025, 4));

  assert.equal(res.status, 400);
});
