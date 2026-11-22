-- 003: record exactly which usage events a stored bill counted.
-- Calculate Bill sets bill_id on the events it sums (in the same transaction), so Query
-- Bill Detailed lists precisely those. Guessing by timestamp (created_at <= calculated_at)
-- was racy: created_at is the Add Usage transaction's START time, so an event committed
-- just after the calculation could carry an earlier timestamp without being in the total.
-- NULL = not billed yet (usage recorded after the last calculation).
ALTER TABLE billing.usage_events
    ADD COLUMN bill_id BIGINT
        CONSTRAINT fk_usage_events_bill_id_bills
            REFERENCES billing.bills (id) ON DELETE SET NULL;

-- Detailed pages a bill's events newest first: this index serves both the count and the
-- ordered page directly, instead of loading and sorting every event of the month.
CREATE INDEX ix_usage_events_bill_id_created_at_id
    ON billing.usage_events (bill_id, created_at DESC, id DESC);
