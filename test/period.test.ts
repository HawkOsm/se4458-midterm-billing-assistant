import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPeriod, isFuturePeriod } from "../src/domain/period";

const NOV_22_2026 = new Date("2026-11-22T12:00:00Z");

test("past and current months are not future", () => {
  assert.equal(isFuturePeriod(2026, 10, NOV_22_2026), false);
  assert.equal(isFuturePeriod(2026, 11, NOV_22_2026), false); // current, unfinished month
  assert.equal(isFuturePeriod(2025, 12, NOV_22_2026), false);
});

test("months after the current one are future", () => {
  assert.equal(isFuturePeriod(2026, 12, NOV_22_2026), true);
  assert.equal(isFuturePeriod(2027, 1, NOV_22_2026), true);
});

test("the month boundary is judged in UTC", () => {
  // 23:30 on Nov 30 in UTC; already December in Istanbul (UTC+3), still November here.
  assert.equal(isFuturePeriod(2026, 12, new Date("2026-11-30T23:30:00Z")), true);
  assert.equal(isFuturePeriod(2026, 12, new Date("2026-12-01T00:00:00Z")), false);
});

test("formatPeriod pads the month", () => {
  assert.equal(formatPeriod(2025, 4), "2025-04");
  assert.equal(formatPeriod(2025, 12), "2025-12");
});
