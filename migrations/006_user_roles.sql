-- 006: login roles.
-- SUBSCRIBER: a customer; acts only on their own subscriber (the AI agent always logs in
--             as one). Exactly one subscriber per SUBSCRIBER login, as before.
-- ADMIN:      the provider's operator / billing system; records usage and calculates or
--             reads bills for any subscriber. Not a subscriber itself, so no subscriber_id.
-- The assignment asks that "administrative operations must be authorized" (common
-- requirements); recording a customer's usage is one of them.
ALTER TABLE billing.users
    ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'SUBSCRIBER',
    ALTER COLUMN subscriber_id DROP NOT NULL,
    ADD CONSTRAINT ck_users_role CHECK (role IN ('SUBSCRIBER', 'ADMIN')),
    -- A subscriber login has a subscriber; an admin login has none.
    ADD CONSTRAINT ck_users_role_subscriber CHECK ((role = 'SUBSCRIBER') = (subscriber_id IS NOT NULL));
