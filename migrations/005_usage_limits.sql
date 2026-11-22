-- 005: usage totals that can't break billing.
-- 1) A month's usage totals were INTEGER (max 2,147,483,647). Add Usage accepts up to
--    10,000 units per call, so a runaway client could push a month past that and make
--    Calculate Bill fail for it. BIGINT removes that ceiling; Calculate Bill also refuses
--    (422) a total that wouldn't fit the NUMERIC(10,2) money columns.
ALTER TABLE billing.bills
    ALTER COLUMN phone_minutes TYPE BIGINT,
    ALTER COLUMN internet_mb TYPE BIGINT;

-- 2) Add Usage derives quantity as amount / unit (10 minutes per PHONE unit, guide §2.3).
--    A PHONE row written any other way with a non-multiple of 10 would give a fractional
--    quantity and break idempotent replays, so the database now refuses it.
ALTER TABLE billing.usage_events
    ADD CONSTRAINT ck_usage_events_phone_whole_units
        CHECK (usage_type <> 'PHONE' OR amount % 10 = 0);
