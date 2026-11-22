import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCents, toCents } from "../src/domain/money";

test("toCents reads NUMERIC text exactly", () => {
  assert.equal(toCents("75.00"), 7500);
  assert.equal(toCents("0.1"), 10);
  assert.equal(toCents("80"), 8000);
  assert.equal(toCents("-5.05"), -505);
  assert.equal(toCents("99999999.99"), 9999999999); // NUMERIC(10,2) maximum
});

test("formatCents always writes two decimals", () => {
  assert.equal(formatCents(7500), "75.00");
  assert.equal(formatCents(5), "0.05");
  assert.equal(formatCents(0), "0.00");
  assert.equal(formatCents(-505), "-5.05");
});

test("cents arithmetic avoids float rounding", () => {
  assert.notEqual(0.1 + 0.2, 0.3); // the reason money is not a JS number of dollars
  assert.equal(formatCents(toCents("0.10") + toCents("0.20")), "0.30");
});

test("toCents rejects malformed values", () => {
  for (const bad of ["", "abc", "1.234", "1,00", "$5"]) {
    assert.throws(() => toCents(bad), /Not a money value/);
  }
});
