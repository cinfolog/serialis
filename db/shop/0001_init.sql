-- Shop database (one per shop, Durable Object `ShopStore`) — spec section 11.2.
-- Lot 0: meta, webhook inbox, transition table and the unit core with its status triggers.
-- Migrations are additive only (spec 10.4): add first, drop two versions later.

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Webhooks received, deduplicated by Shopify's webhook id (P2: delivery order is not guaranteed).
CREATE TABLE inbox (
  webhook_id   TEXT PRIMARY KEY,
  topic        TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  triggered_at TEXT,
  payload      TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX inbox_unprocessed ON inbox (processed_at) WHERE processed_at IS NULL;

-- Copy of core/src/transitions.ts; empty from_status = creation.
CREATE TABLE allowed_transitions (
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  guarded     INTEGER NOT NULL CHECK (guarded IN (0, 1)),
  PRIMARY KEY (from_status, to_status)
) WITHOUT ROWID;

CREATE TABLE units (
  id          TEXT PRIMARY KEY,
  variant_gid TEXT NOT NULL,
  location_id TEXT,
  status      TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  -- A counted state requires a location (spec 7.1).
  CHECK (status NOT IN ('AVAILABLE', 'HELD', 'ALLOCATED', 'QUALITY_CONTROL', 'DAMAGED') OR location_id IS NOT NULL)
);

CREATE TRIGGER units_status_on_insert
BEFORE INSERT ON units
WHEN NOT EXISTS (SELECT 1 FROM allowed_transitions WHERE from_status = '' AND to_status = NEW.status)
BEGIN
  SELECT RAISE(ABORT, 'forbidden_transition');
END;

CREATE TRIGGER units_status_on_update
BEFORE UPDATE OF status ON units
WHEN NOT EXISTS (SELECT 1 FROM allowed_transitions WHERE from_status = OLD.status AND to_status = NEW.status)
BEGIN
  SELECT RAISE(ABORT, 'forbidden_transition');
END;

-- Optimistic lock: every status change must bump the version (spec 7.3, last rule).
CREATE TRIGGER units_version_on_update
BEFORE UPDATE OF status ON units
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'stale_unit_version');
END;
