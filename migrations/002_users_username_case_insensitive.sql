-- 002: login matches usernames case-insensitively (lower(username) = lower($1)), so
-- uniqueness must be case-insensitive too; otherwise "Ayse" and "ayse" could both exist
-- and one login would match two users. The index also makes that lookup fast.
CREATE UNIQUE INDEX uq_users_username_lower ON billing.users (lower(username));
