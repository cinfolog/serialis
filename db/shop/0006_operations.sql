-- Shop database, operations of the MVP beta (spec 15.8, 16.1, 17): app users and the indexes of the
-- daily purge. Additive only (spec 10.4). Conventions: timestamps in ms UTC (INTEGER).

-- Users of the shop who opened the app (15.8): Shopify user id (`sub` of the session or ID token),
-- first name only when provided, never an e-mail. `is_owner` = first user seen by the base (installer,
-- workers/DECISIONS.md 46); administrators are the owner and the users they designate.
CREATE TABLE app_users (
  shopify_user_id       TEXT PRIMARY KEY,
  first_name            TEXT,
  is_owner              INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
  is_admin              INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  designated_by         TEXT,
  preferred_location_id TEXT,
  first_seen_at         INTEGER NOT NULL,
  last_seen_at          INTEGER NOT NULL,
  CHECK (is_owner = 0 OR is_admin = 1)
);
CREATE UNIQUE INDEX app_users_single_owner ON app_users (is_owner) WHERE is_owner = 1;

-- Daily purge (16.1, task `purge`): every deletion goes through an index, in batches.
CREATE INDEX inbox_received ON inbox (received_at);
CREATE INDEX outbox_completed ON outbox (completed_at) WHERE status IN ('done', 'failed');
CREATE INDEX outbox_depends_on ON outbox (depends_on) WHERE depends_on IS NOT NULL;
CREATE INDEX imports_created ON imports (created_at);
CREATE INDEX unit_locks_expiry ON unit_locks (expires_at);
