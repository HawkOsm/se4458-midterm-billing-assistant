-- 007: the provider's systems authenticate with API keys, not a user login.
-- Recording usage and running bills is done by systems (the network's usage collector,
-- the billing run), so they get access keys; `users` goes back to people (subscribers).

-- One row per key. Only a SHA-256 hash is stored: the key itself is shown once when it
-- is created and can't be recovered from the database. Keys are long random values,
-- so a fast hash is enough (unlike human passwords, which get slow scrypt).
CREATE TABLE billing.api_keys (
    id         BIGSERIAL    CONSTRAINT pk_api_keys PRIMARY KEY,
    name       VARCHAR(100) NOT NULL CONSTRAINT uq_api_keys_name UNIQUE,  -- e.g. "usage-collector"
    key_hash   CHAR(64)     NOT NULL CONSTRAINT uq_api_keys_key_hash UNIQUE,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,                                              -- NULL = active
    CONSTRAINT ck_api_keys_key_hash_hex CHECK (key_hash ~ '^[0-9a-f]{64}$')
);

-- Undo 006's admin login: users are subscribers only again.
DELETE FROM billing.users WHERE role = 'ADMIN';
ALTER TABLE billing.users
    DROP CONSTRAINT ck_users_role_subscriber,
    DROP CONSTRAINT ck_users_role,
    DROP COLUMN role,
    ALTER COLUMN subscriber_id SET NOT NULL;
