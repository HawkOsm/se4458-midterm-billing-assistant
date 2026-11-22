-- 001: billing schema (see docs/data-model.md).
-- Business rules that must never be violated are enforced here, by the database itself
-- (UNIQUE / CHECK / FOREIGN KEY), not only by application code.
-- Money is NUMERIC(10,2): exact decimal, never floating point.

CREATE SCHEMA billing;

CREATE TABLE billing.subscribers (
    id            BIGSERIAL    CONSTRAINT pk_subscribers PRIMARY KEY,
    subscriber_no VARCHAR(20)  NOT NULL CONSTRAINT uq_subscribers_subscriber_no UNIQUE,
    full_name     VARCHAR(100) NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Login identity; exactly one per subscriber. JWT `sub` = subscriber_no.
CREATE TABLE billing.users (
    id            BIGSERIAL    CONSTRAINT pk_users PRIMARY KEY,
    subscriber_id BIGINT       NOT NULL
        CONSTRAINT uq_users_subscriber_id UNIQUE
        CONSTRAINT fk_users_subscriber_id_subscribers
            REFERENCES billing.subscribers (id) ON DELETE CASCADE,
    username      VARCHAR(50)  NOT NULL CONSTRAINT uq_users_username UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- One row per Add Usage call: 10 phone minutes or 1 MB of internet.
CREATE TABLE billing.usage_events (
    id              BIGSERIAL    CONSTRAINT pk_usage_events PRIMARY KEY,
    subscriber_id   BIGINT       NOT NULL
        CONSTRAINT fk_usage_events_subscriber_id_subscribers
            REFERENCES billing.subscribers (id) ON DELETE CASCADE,
    period_year     SMALLINT     NOT NULL,
    period_month    SMALLINT     NOT NULL,
    usage_type      VARCHAR(20)  NOT NULL,
    amount          INTEGER      NOT NULL,  -- minutes for PHONE, MB for INTERNET
    idempotency_key VARCHAR(100) NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Required Idempotency-Key: a retry finds this row instead of adding usage again.
    CONSTRAINT uq_usage_events_subscriber_id_idempotency_key UNIQUE (subscriber_id, idempotency_key),
    CONSTRAINT ck_usage_events_usage_type CHECK (usage_type IN ('PHONE', 'INTERNET')),
    CONSTRAINT ck_usage_events_month_range CHECK (period_month BETWEEN 1 AND 12),
    CONSTRAINT ck_usage_events_year_range CHECK (period_year BETWEEN 2000 AND 2100),
    CONSTRAINT ck_usage_events_amount_positive CHECK (amount > 0)
);
-- Calculate Bill and Query Bill Detailed both filter by subscriber + period.
CREATE INDEX ix_usage_events_subscriber_id_period_year_period_month
    ON billing.usage_events (subscriber_id, period_year, period_month);

-- Stored result of Calculate Bill; one per subscriber per month.
CREATE TABLE billing.bills (
    id              BIGSERIAL     CONSTRAINT pk_bills PRIMARY KEY,
    subscriber_id   BIGINT        NOT NULL
        CONSTRAINT fk_bills_subscriber_id_subscribers
            REFERENCES billing.subscribers (id) ON DELETE CASCADE,
    period_year     SMALLINT      NOT NULL,
    period_month    SMALLINT      NOT NULL,
    phone_minutes   INTEGER       NOT NULL,
    internet_mb     INTEGER       NOT NULL,
    phone_charge    NUMERIC(10,2) NOT NULL,
    internet_charge NUMERIC(10,2) NOT NULL,
    total           NUMERIC(10,2) NOT NULL,
    paid_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,
    status          VARCHAR(20)   NOT NULL DEFAULT 'UNPAID',
    -- Also the bill's issue date for the 15-day dispute window (guide §7.1).
    calculated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT uq_bills_subscriber_id_period_year_period_month
        UNIQUE (subscriber_id, period_year, period_month),
    CONSTRAINT ck_bills_bill_status CHECK (status IN ('UNPAID', 'PARTIALLY_PAID', 'PAID')),
    CONSTRAINT ck_bills_month_range CHECK (period_month BETWEEN 1 AND 12),
    CONSTRAINT ck_bills_year_range CHECK (period_year BETWEEN 2000 AND 2100),
    CONSTRAINT ck_bills_usage_non_negative CHECK (phone_minutes >= 0 AND internet_mb >= 0),
    CONSTRAINT ck_bills_charges_non_negative CHECK (phone_charge >= 0 AND internet_charge >= 0),
    CONSTRAINT ck_bills_total_sum CHECK (total = phone_charge + internet_charge),
    -- "Preserve balance": paid can never go below 0 or above the total.
    CONSTRAINT ck_bills_paid_range CHECK (paid_amount >= 0 AND paid_amount <= total)
);

-- One row per accepted Pay Bill call. transaction_id is the idempotency key.
CREATE TABLE billing.payments (
    id                BIGSERIAL     CONSTRAINT pk_payments PRIMARY KEY,
    bill_id           BIGINT        NOT NULL
        CONSTRAINT fk_payments_bill_id_bills
            REFERENCES billing.bills (id) ON DELETE RESTRICT,
    transaction_id    VARCHAR(100)  NOT NULL CONSTRAINT uq_payments_transaction_id UNIQUE,
    amount            NUMERIC(10,2) NOT NULL,
    -- Snapshot of the result, so a retried transaction_id replays the same response.
    paid_amount_after NUMERIC(10,2) NOT NULL,
    remaining_after   NUMERIC(10,2) NOT NULL,
    status_after      VARCHAR(20)   NOT NULL,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT ck_payments_amount_positive CHECK (amount > 0),
    CONSTRAINT ck_payments_payment_status_after
        CHECK (status_after IN ('UNPAID', 'PARTIALLY_PAID', 'PAID'))
);
CREATE INDEX ix_payments_bill_id ON billing.payments (bill_id);
