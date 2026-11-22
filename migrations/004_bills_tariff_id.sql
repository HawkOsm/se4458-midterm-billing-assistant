-- 004: each bill records which price list (tariff) it was calculated with, so a later
-- price change can't make an old bill's breakdown be explained with the new prices.
-- The id is the billing guide's document ID (Mobile_Provider_Billing_Guide.md, v1.0).
ALTER TABLE billing.bills
    ADD COLUMN tariff_id VARCHAR(40) NOT NULL DEFAULT 'MOB-BILLING-2026-01';
