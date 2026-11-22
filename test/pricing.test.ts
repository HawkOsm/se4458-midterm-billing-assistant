// Every pricing example stated in Mobile_Provider_Billing_Guide.md, checked literally.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MOB_BILLING_2026_01, getTariff, internetChargeCents, phoneChargeCents } from "../src/domain/pricing";

test("phone: first 1,000 minutes free, then $10 per started 1,000-minute block (§2.1–2.2)", () => {
  assert.equal(phoneChargeCents(0), 0);
  assert.equal(phoneChargeCents(1000), 0);
  assert.equal(phoneChargeCents(1001), 1000); // guide: 1,001 minutes costs $10
  assert.equal(phoneChargeCents(2000), 1000);
  assert.equal(phoneChargeCents(2001), 2000); // guide: 2,001 minutes costs $20
});

test("internet: $50 up to 20 GB, then $10 per started 10 GB block (§3.1–3.2)", () => {
  assert.equal(internetChargeCents(0), 5000); // §3.1: charged even with zero usage
  assert.equal(internetChargeCents(20_000), 5000); // guide: 20 GB costs $50
  assert.equal(internetChargeCents(20_001), 6000); // a started block is a full block
  assert.equal(internetChargeCents(21_000), 6000); // guide: 21 GB costs $60
  assert.equal(internetChargeCents(30_000), 6000); // guide: 30 GB costs $60
  assert.equal(internetChargeCents(35_000), 7000); // guide: 35 GB costs $70
});

test("worked example: 1,350 minutes + 35 GB = $80 (§4.3)", () => {
  assert.equal(phoneChargeCents(1350) + internetChargeCents(35_000), 8000);
});

test("bills are explained with the tariff they were calculated with", () => {
  const tariff = getTariff("MOB-BILLING-2026-01");
  assert.equal(tariff, MOB_BILLING_2026_01);
  assert.throws(() => getTariff("NO-SUCH-TARIFF"), /Unknown tariff/);
});
