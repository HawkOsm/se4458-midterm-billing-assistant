// The database itself must reject data that breaks a business rule (migrations/001).
// Each case asserts the exact constraint name, so a test can't pass for the wrong reason
// (e.g. a primary-key collision instead of the rule being tested).
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import {
  beginTestTransaction,
  closePool,
  insertBill,
  insertSubscriber,
  prepareTestDatabase,
  type TestTx,
} from "./helpers";

let tx: TestTx;

before(prepareTestDatabase);
after(closePool);
beforeEach(async () => {
  tx = await beginTestTransaction();
});
afterEach(async () => {
  await tx.rollback();
});

// Runs `sql` inside a savepoint (so the outer test transaction survives the error)
// and asserts it fails on exactly `constraint`.
async function assertRejectedBy(constraint: string, sql: string, params: unknown[] = []): Promise<void> {
  await tx.client.query("SAVEPOINT attempt");
  try {
    await tx.client.query(sql, params);
    assert.fail(`expected ${constraint} to reject the statement`);
  } catch (err) {
    assert.equal((err as { constraint?: string }).constraint, constraint);
  } finally {
    await tx.client.query("ROLLBACK TO SAVEPOINT attempt");
  }
}

const insertPayment = `INSERT INTO billing.payments
  (bill_id, transaction_id, amount, paid_amount_after, remaining_after, status_after)
  VALUES ($1, $2, $3, $3, 0, 'PAID')`;

test("a subscriber number is unique", async () => {
  await insertSubscriber(tx.client, "5551234");
  await assertRejectedBy(
    "uq_subscribers_subscriber_no",
    "INSERT INTO billing.subscribers (subscriber_no, full_name) VALUES ('5551234', 'Twin')",
  );
});

test("one bill per subscriber per month", async () => {
  const billId = await insertBill(tx.client);
  await assertRejectedBy(
    "uq_bills_subscriber_id_period_year_period_month",
    `INSERT INTO billing.bills (subscriber_id, period_year, period_month, phone_minutes,
       internet_mb, phone_charge, internet_charge, total)
     SELECT subscriber_id, 2025, 4, 0, 0, 0, 50, 50 FROM billing.bills WHERE id = $1`,
    [billId],
  );
});

test("total must equal phone + internet", async () => {
  const billId = await insertBill(tx.client);
  await assertRejectedBy("ck_bills_total_sum", "UPDATE billing.bills SET total = 99 WHERE id = $1", [billId]);
});

test("paid amount can never exceed the total", async () => {
  const billId = await insertBill(tx.client);
  await assertRejectedBy("ck_bills_paid_range", "UPDATE billing.bills SET paid_amount = 75.01 WHERE id = $1", [billId]);
});

test("bill month must be 1-12", async () => {
  const billId = await insertBill(tx.client);
  await assertRejectedBy("ck_bills_month_range", "UPDATE billing.bills SET period_month = 13 WHERE id = $1", [billId]);
});

test("bill status must be a known value", async () => {
  const billId = await insertBill(tx.client);
  await assertRejectedBy("ck_bills_bill_status", "UPDATE billing.bills SET status = 'LATE' WHERE id = $1", [billId]);
});

test("usage type must be PHONE or INTERNET", async () => {
  const subscriberId = await insertSubscriber(tx.client, "5551234");
  await assertRejectedBy(
    "ck_usage_events_usage_type",
    `INSERT INTO billing.usage_events (subscriber_id, period_year, period_month, usage_type, amount, idempotency_key)
     VALUES ($1, 2025, 4, 'SMS', 1, 'k1')`,
    [subscriberId],
  );
});

test("an Add Usage idempotency key can't be reused by the same subscriber", async () => {
  const subscriberId = await insertSubscriber(tx.client, "5551234");
  const sql = `INSERT INTO billing.usage_events (subscriber_id, period_year, period_month, usage_type, amount, idempotency_key)
               VALUES ($1, 2025, 4, 'PHONE', 10, 'same-key')`;
  await tx.client.query(sql, [subscriberId]);
  await assertRejectedBy("uq_usage_events_subscriber_id_idempotency_key", sql, [subscriberId]);
});

test("a payment transaction ID is unique", async () => {
  const billId = await insertBill(tx.client);
  await tx.client.query(insertPayment, [billId, "tx-1", "10.00"]);
  await assertRejectedBy("uq_payments_transaction_id", insertPayment, [billId, "tx-1", "10.00"]);
});

test("a payment amount must be positive", async () => {
  const billId = await insertBill(tx.client);
  await assertRejectedBy("ck_payments_amount_positive", insertPayment, [billId, "tx-0", "0.00"]);
});

test("a bill with payments can't be deleted", async () => {
  const billId = await insertBill(tx.client);
  await tx.client.query(insertPayment, [billId, "tx-2", "10.00"]);
  await assertRejectedBy("fk_payments_bill_id_bills", "DELETE FROM billing.bills WHERE id = $1", [billId]);
});

test("a PHONE event must be whole 10-minute units", async () => {
  const subscriberId = await insertSubscriber(tx.client, "5551234");
  await assertRejectedBy(
    "ck_usage_events_phone_whole_units",
    `INSERT INTO billing.usage_events (subscriber_id, period_year, period_month, usage_type, amount, idempotency_key)
     VALUES ($1, 2025, 4, 'PHONE', 15, 'odd-minutes')`,
    [subscriberId],
  );
});

test("API keys: names and hashes are unique, and a hash must be 64 hex characters", async () => {
  const hash = "a".repeat(64);
  await tx.client.query("INSERT INTO billing.api_keys (name, key_hash) VALUES ('collector', $1)", [hash]);
  await assertRejectedBy("uq_api_keys_name", "INSERT INTO billing.api_keys (name, key_hash) VALUES ('collector', $1)", ["b".repeat(64)]);
  await assertRejectedBy("uq_api_keys_key_hash", "INSERT INTO billing.api_keys (name, key_hash) VALUES ('other', $1)", [hash]);
  await assertRejectedBy("ck_api_keys_key_hash_hex", "INSERT INTO billing.api_keys (name, key_hash) VALUES ('raw', $1)", ["the-plain-key".padEnd(64, "x")]);
});

test("every login belongs to a subscriber again (no admin logins)", async () => {
  await tx.client.query("SAVEPOINT attempt");
  await assert.rejects(
    tx.client.query("INSERT INTO billing.users (subscriber_id, username, password_hash) VALUES (NULL, 'admin', 'h')"),
    (err: { code?: string; column?: string }) => err.code === "23502" && err.column === "subscriber_id", // not_null_violation
  );
  await tx.client.query("ROLLBACK TO SAVEPOINT attempt");
});

