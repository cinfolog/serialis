-- Shop database, platform tables (spec 11.2, 12.2, 12.4, 13.7, 13.9).
-- Conventions of section 11: timestamps in ms UTC (INTEGER), JSON in TEXT checked by json_valid, encrypted data in BLOB.

-- Single row: the shop's expiring offline token pair, encrypted with AES-GCM (spec 16).
-- `previous_refresh_token_enc` is the refresh token used for the last successful refresh, kept until
-- the new one has been used once (spec 13.9: a lost refresh response is retried with it).
CREATE TABLE shopify_token (
  id                          INTEGER PRIMARY KEY CHECK (id = 1),
  access_token_enc            BLOB NOT NULL,
  access_expires_at           INTEGER NOT NULL,
  refresh_token_enc           BLOB NOT NULL,
  refresh_expires_at          INTEGER NOT NULL,
  previous_refresh_token_enc  BLOB,
  previous_refresh_expires_at INTEGER,
  key_version                 INTEGER NOT NULL,
  scopes                      TEXT NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN ('valid', 'refreshing', 'reconnect_required')),
  updated_at                  INTEGER NOT NULL
);

-- Scheduled work (spec 12.2). The object's alarm is always set to the smallest pending run_at.
CREATE TABLE tasks (
  key             TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  payload         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  run_at          INTEGER NOT NULL,
  deadline_at     INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'running', 'dead')),
  lease_until     INTEGER,
  lease_token     TEXT,
  rerun_requested INTEGER NOT NULL DEFAULT 0 CHECK (rerun_requested IN (0, 1)),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  priority        INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX tasks_due ON tasks (status, priority, run_at);

-- Transactional outbox of Shopify writes (spec 12.4).
CREATE TABLE outbox (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                TEXT NOT NULL CHECK (kind IN (
                        'inventory_activate', 'inventory_adjust', 'inventory_move', 'inventory_set',
                        'hold_place', 'hold_release', 'metafield_set', 'variant_create', 'variant_update',
                        'variant_delete', 'product_create', 'product_update', 'publishable_publish',
                        'draft_order_update', 'inventory_item_update', 'webhook_out')),
  serial_key          TEXT NOT NULL,
  depends_on          INTEGER REFERENCES outbox (id),
  -- Caller-provided key: enqueuing the same write twice (at-least-once callers) keeps one row.
  dedupe_key          TEXT UNIQUE,
  -- Frozen request: { "query": "...", "variables": { ... } }.
  payload             TEXT NOT NULL CHECK (json_valid(payload)),
  revision            INTEGER NOT NULL DEFAULT 0,
  revision_started_at INTEGER,
  idempotency_key     TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'in_flight', 'done', 'failed', 'dead')),
  lease_until         INTEGER,
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     INTEGER NOT NULL,
  last_error          TEXT,
  result              TEXT CHECK (result IS NULL OR json_valid(result)),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  completed_at        INTEGER
);
CREATE INDEX outbox_due ON outbox (status, next_attempt_at);
CREATE INDEX outbox_serial ON outbox (serial_key, id);

-- Compliance webhooks (spec 13.7): only Shopify identifiers are kept, never customer details (P8).
CREATE TABLE compliance_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id      TEXT NOT NULL UNIQUE,
  topic           TEXT NOT NULL CHECK (topic IN ('customers/data_request', 'customers/redact', 'shop/redact')),
  order_gids      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(order_gids)),
  data_request_id TEXT,
  status          TEXT NOT NULL CHECK (status IN ('received', 'processing', 'done', 'ignored')),
  received_at     INTEGER NOT NULL,
  processed_at    INTEGER
);
CREATE INDEX compliance_requests_open ON compliance_requests (status) WHERE status IN ('received', 'processing');
