-- Shop database, domain tables of the MVP (spec 11.2, 12.3 to 12.5, 19.4).
-- Additive only (spec 10.4): `units` and `outbox` gain columns, nothing is dropped or rewritten.
-- Conventions: timestamps in ms UTC (INTEGER) for every new column; JSON in TEXT checked by json_valid.
-- Locations are identified by their Shopify GID (workers/DECISIONS.md, D-21: identity mapping of core D-01).

CREATE TABLE locations (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  externally_managed INTEGER NOT NULL DEFAULT 0 CHECK (externally_managed IN (0, 1)),
  updated_at         INTEGER NOT NULL
);

CREATE TABLE tracked_items (
  id                        TEXT PRIMARY KEY,
  product_gid               TEXT NOT NULL,
  variant_gid               TEXT,
  inventory_item_gid        TEXT,
  mode                      TEXT NOT NULL CHECK (mode IN ('pooled', 'unique')),
  required_identifier_types TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(required_identifier_types)),
  initializing              INTEGER NOT NULL DEFAULT 1 CHECK (initializing IN (0, 1)),
  activated_at              INTEGER NOT NULL,
  apply_to_open_orders      INTEGER NOT NULL DEFAULT 0 CHECK (apply_to_open_orders IN (0, 1)),
  active                    INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  -- Display copies read at activation (no customer data).
  product_title             TEXT,
  variant_title             TEXT,
  sku                       TEXT,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  CHECK (mode <> 'pooled' OR (variant_gid IS NOT NULL AND inventory_item_gid IS NOT NULL))
);
CREATE UNIQUE INDEX tracked_items_active_variant ON tracked_items (variant_gid) WHERE active = 1 AND variant_gid IS NOT NULL;
CREATE INDEX tracked_items_inventory_item ON tracked_items (inventory_item_gid);
CREATE INDEX tracked_items_sku ON tracked_items (sku);

-- Units: columns of 11.2 added to the lot 0 core (status and version triggers of 0001 stay as they are).
ALTER TABLE units ADD COLUMN tracked_item_id TEXT REFERENCES tracked_items (id);
ALTER TABLE units ADD COLUMN primary_identifier TEXT;
ALTER TABLE units ADD COLUMN primary_identifier_type TEXT;
ALTER TABLE units ADD COLUMN received_at INTEGER;
ALTER TABLE units ADD COLUMN expires_at INTEGER;
ALTER TABLE units ADD COLUMN warranty_ends_at INTEGER;
ALTER TABLE units ADD COLUMN hold_moved_stock INTEGER NOT NULL DEFAULT 0;
ALTER TABLE units ADD COLUMN native_shipment_gid TEXT;
ALTER TABLE units ADD COLUMN attributes TEXT NOT NULL DEFAULT '{}';
ALTER TABLE units ADD COLUMN created_ms INTEGER;
ALTER TABLE units ADD COLUMN updated_ms INTEGER;
CREATE INDEX units_allocation ON units (tracked_item_id, location_id, status, received_at);
CREATE INDEX units_supervision ON units (status, updated_ms);

-- EF-06: a unit is never deleted.
CREATE TRIGGER units_no_delete
BEFORE DELETE ON units
BEGIN
  SELECT RAISE(ABORT, 'unit_delete_forbidden');
END;

CREATE TABLE identifier_types (
  key             TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  normalize_upper INTEGER NOT NULL DEFAULT 1 CHECK (normalize_upper IN (0, 1)),
  strip_spaces    INTEGER NOT NULL DEFAULT 1 CHECK (strip_spaces IN (0, 1)),
  validation      TEXT NOT NULL DEFAULT 'none' CHECK (validation IN ('none', 'luhn', 'regex')),
  regex           TEXT,
  scope           TEXT NOT NULL DEFAULT 'shop' CHECK (scope IN ('shop', 'product'))
);
INSERT INTO identifier_types (key, label) VALUES ('serial', 'Serial number');

-- EF-03: unique per type and scope on the normalised value, while not retired (EF-08).
CREATE TABLE unit_identifiers (
  id         TEXT PRIMARY KEY,
  unit_id    TEXT NOT NULL REFERENCES units (id),
  type       TEXT NOT NULL,
  value      TEXT NOT NULL,
  value_norm TEXT NOT NULL,
  scope_key  TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  retired_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX unit_identifiers_unique ON unit_identifiers (type, scope_key, value_norm) WHERE retired_at IS NULL;
CREATE UNIQUE INDEX unit_identifiers_primary ON unit_identifiers (unit_id) WHERE is_primary = 1 AND retired_at IS NULL;
CREATE INDEX unit_identifiers_norm ON unit_identifiers (value_norm);
CREATE INDEX unit_identifiers_unit ON unit_identifiers (unit_id);

-- One row per unit (11.2). G1: a unit is engaged in at most one active or fulfilled allocation.
CREATE TABLE allocations (
  id                              TEXT PRIMARY KEY,
  unit_id                         TEXT NOT NULL REFERENCES units (id),
  variant_gid                     TEXT NOT NULL,
  order_gid                       TEXT NOT NULL,
  line_item_gid                   TEXT NOT NULL,
  fulfillment_order_gid           TEXT,
  fulfillment_order_line_item_gid TEXT,
  location_id                     TEXT NOT NULL,
  status                          TEXT NOT NULL CHECK (status IN ('active', 'fulfilled', 'released', 'returned')),
  source                          TEXT NOT NULL CHECK (source IN ('auto', 'pick', 'pos', 'draft', 'api', 'late', 'migration')),
  return_expected                 INTEGER NOT NULL DEFAULT 0 CHECK (return_expected IN (0, 1)),
  to_confirm                      INTEGER NOT NULL DEFAULT 0 CHECK (to_confirm IN (0, 1)),
  allocation_version              INTEGER NOT NULL DEFAULT 1,
  allocated_at                    INTEGER NOT NULL,
  fulfilled_at                    INTEGER,
  released_at                     INTEGER,
  returned_at                     INTEGER,
  -- core D-05: why the allocation was released.
  release_kind                    TEXT CHECK (release_kind IS NULL OR release_kind IN ('restocked', 'not_restocked', 'relocated', 'ignored_order', 'manual')),
  -- core D-06: return line the unit is expected back on (role of expected_returns.identified_unit_ids).
  return_line_item_gid            TEXT,
  CHECK (status <> 'fulfilled' OR fulfilled_at IS NOT NULL),
  CHECK (status <> 'released' OR released_at IS NOT NULL),
  CHECK (status <> 'returned' OR returned_at IS NOT NULL)
);
CREATE UNIQUE INDEX allocations_engaged_unit ON allocations (unit_id) WHERE status IN ('active', 'fulfilled');
CREATE INDEX allocations_order ON allocations (order_gid);
CREATE INDEX allocations_line ON allocations (line_item_gid, location_id, status);
CREATE INDEX allocations_fo_line ON allocations (fulfillment_order_line_item_gid, status);

-- 7.3 / 11.2: an engaged allocation has the unit's variant and the unit's location.
CREATE TRIGGER allocations_consistency_insert
BEFORE INSERT ON allocations
WHEN NEW.status IN ('active', 'fulfilled') AND NOT EXISTS (
  SELECT 1 FROM units u JOIN tracked_items t ON t.id = u.tracked_item_id
  WHERE u.id = NEW.unit_id AND t.variant_gid = NEW.variant_gid AND u.location_id = NEW.location_id
)
BEGIN
  SELECT RAISE(ABORT, 'allocation_mismatch');
END;

CREATE TRIGGER allocations_consistency_update
BEFORE UPDATE OF status, unit_id, variant_gid, location_id ON allocations
WHEN NEW.status IN ('active', 'fulfilled') AND NOT EXISTS (
  SELECT 1 FROM units u JOIN tracked_items t ON t.id = u.tracked_item_id
  WHERE u.id = NEW.unit_id AND t.variant_gid = NEW.variant_gid AND u.location_id = NEW.location_id
)
BEGIN
  SELECT RAISE(ABORT, 'allocation_mismatch');
END;

CREATE TABLE unit_locks (
  unit_id    TEXT PRIMARY KEY REFERENCES units (id),
  kind       TEXT NOT NULL CHECK (kind IN ('pos', 'pick', 'api')),
  owner      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Catalogue 12.7. `fingerprint` = SHA-256 of `fingerprint_key` (core D-07); subject columns copied for the filters.
CREATE TABLE anomalies (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  subject         TEXT NOT NULL CHECK (json_valid(subject)),
  order_gid       TEXT,
  unit_id         TEXT,
  tracked_item_id TEXT,
  location_id     TEXT,
  variant_gid     TEXT,
  fingerprint     TEXT NOT NULL,
  fingerprint_key TEXT NOT NULL,
  details         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details)),
  status          TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved', 'auto_resolved')),
  resolution      TEXT CHECK (resolution IS NULL OR json_valid(resolution)),
  detected_at     INTEGER NOT NULL,
  resolved_at     INTEGER,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX anomalies_live_fingerprint ON anomalies (fingerprint) WHERE status IN ('open', 'acknowledged');
CREATE INDEX anomalies_order ON anomalies (order_gid);
CREATE INDEX anomalies_list ON anomalies (status, detected_at);
CREATE INDEX anomalies_item_location ON anomalies (tracked_item_id, location_id);

-- Append-only history (EF-34, G6). Archive and redaction exceptions come with lot 5.
CREATE TABLE unit_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id     TEXT NOT NULL,
  type        TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system', 'shopify')),
  actor_id    TEXT,
  cause_type  TEXT NOT NULL CHECK (cause_type IN ('webhook', 'task', 'api_request', 'ui_action', 'reconciliation', 'migration')),
  cause_id    TEXT,
  order_gid   TEXT,
  location_id TEXT,
  data        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  occurred_at INTEGER NOT NULL
);
CREATE INDEX unit_events_unit ON unit_events (unit_id, id);
CREATE INDEX unit_events_order ON unit_events (order_gid);
CREATE TRIGGER unit_events_append_only_update BEFORE UPDATE ON unit_events BEGIN SELECT RAISE(ABORT, 'append_only'); END;
CREATE TRIGGER unit_events_append_only_delete BEFORE DELETE ON unit_events BEGIN SELECT RAISE(ABORT, 'append_only'); END;

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type  TEXT NOT NULL,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  before      TEXT CHECK (before IS NULL OR json_valid(before)),
  after       TEXT CHECK (after IS NULL OR json_valid(after)),
  occurred_at INTEGER NOT NULL
);
CREATE TRIGGER audit_log_append_only_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'append_only'); END;
CREATE TRIGGER audit_log_append_only_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'append_only'); END;

-- Setting values per scope (6.6.1); validated against core/src/settings.ts before writing.
CREATE TABLE settings (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('shop', 'location', 'tracked_item')),
  scope_id   TEXT NOT NULL DEFAULT '',
  key        TEXT NOT NULL,
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_type, scope_id, key)
) WITHOUT ROWID;

CREATE TABLE explained_quantities (
  id              TEXT PRIMARY KEY,
  source_type     TEXT NOT NULL CHECK (source_type IN ('return_unidentified', 'to_verify_restocked', 'native_receipt_undesignated',
                    'native_shipment_undesignated', 'pre_activation_return', 'sale_without_unit', 'preexisting_sale', 'test_order_shipment')),
  source_ref      TEXT NOT NULL,
  -- Order whose synchronization owns the row (replaced as a whole set by sync_order).
  order_gid       TEXT,
  tracked_item_id TEXT NOT NULL,
  location_id     TEXT NOT NULL,
  inventory_state TEXT NOT NULL CHECK (inventory_state IN ('available', 'quality_control', 'damaged')),
  direction       TEXT NOT NULL CHECK (direction IN ('surplus', 'deficit')),
  quantity        INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  opened_at       INTEGER NOT NULL,
  closed_at       INTEGER
);
CREATE INDEX explained_quantities_level ON explained_quantities (tracked_item_id, location_id, status);
CREATE INDEX explained_quantities_order ON explained_quantities (order_gid, status);
CREATE UNIQUE INDEX explained_quantities_open ON explained_quantities (source_type, source_ref, tracked_item_id, location_id, inventory_state) WHERE status = 'open';

CREATE TABLE order_sync (
  order_gid          TEXT PRIMARY KEY,
  status             TEXT NOT NULL CHECK (status IN ('ok', 'pending', 'short', 'error', 'ignored', 'redacted')),
  metafield_hash     TEXT,
  has_tracked_lines  INTEGER NOT NULL DEFAULT 0 CHECK (has_tracked_lines IN (0, 1)),
  last_synced_at     INTEGER,
  shopify_updated_at INTEGER,
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT
);
CREATE INDEX order_sync_open ON order_sync (status) WHERE status IN ('pending', 'short', 'error');

CREATE TABLE uncovered_lines (
  fo_line_item_gid TEXT PRIMARY KEY,
  order_gid        TEXT NOT NULL,
  line_item_gid    TEXT NOT NULL,
  fo_gid           TEXT NOT NULL,
  tracked_item_id  TEXT NOT NULL,
  location_id      TEXT NOT NULL,
  quantity         INTEGER NOT NULL,
  since            INTEGER NOT NULL
);
CREATE INDEX uncovered_lines_level ON uncovered_lines (tracked_item_id, location_id);
CREATE INDEX uncovered_lines_order ON uncovered_lines (order_gid);

CREATE TABLE order_line_tracking (
  order_gid       TEXT NOT NULL,
  line_item_gid   TEXT NOT NULL,
  tracked_item_id TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('tracked', 'preexisting')),
  PRIMARY KEY (order_gid, line_item_gid)
) WITHOUT ROWID;

-- Lines of the last order read (display of GET /orders/{id}/allocations and line order of the metafield).
CREATE TABLE order_lines (
  order_gid        TEXT NOT NULL,
  line_item_gid    TEXT NOT NULL,
  position         INTEGER NOT NULL,
  variant_gid      TEXT,
  title            TEXT NOT NULL DEFAULT '',
  quantity         INTEGER NOT NULL,
  current_quantity INTEGER NOT NULL,
  tracked          INTEGER NOT NULL CHECK (tracked IN (0, 1)),
  PRIMARY KEY (order_gid, line_item_gid)
) WITHOUT ROWID;

-- Removals of order edits as delivered by `orders/edited` (restock flag when present, PV-14).
CREATE TABLE order_edit_removals (
  order_gid     TEXT NOT NULL,
  edit_id       TEXT NOT NULL,
  line_item_gid TEXT NOT NULL,
  quantity      INTEGER NOT NULL,
  restock       INTEGER CHECK (restock IS NULL OR restock IN (0, 1)),
  received_at   INTEGER NOT NULL,
  PRIMARY KEY (edit_id, line_item_gid)
) WITHOUT ROWID;
CREATE INDEX order_edit_removals_order ON order_edit_removals (order_gid);

-- Correspondence tables (12.1) for topics that do not carry the order id.
CREATE TABLE fulfillment_orders (
  fo_gid      TEXT PRIMARY KEY,
  order_gid   TEXT NOT NULL,
  location_id TEXT NOT NULL,
  status      TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX fulfillment_orders_order ON fulfillment_orders (order_gid);
CREATE TABLE return_map (
  return_gid TEXT PRIMARY KEY,
  order_gid  TEXT NOT NULL
);
CREATE TABLE return_lines (
  return_line_gid TEXT PRIMARY KEY,
  return_gid      TEXT NOT NULL,
  order_gid       TEXT NOT NULL,
  line_item_gid   TEXT NOT NULL,
  quantity        INTEGER NOT NULL
);
CREATE INDEX return_lines_return ON return_lines (return_gid);

-- Refs typed at return reception (EF-21, S-17), already matched by the designation rule (15.5); null = unknown ref.
CREATE TABLE return_identifications (
  id                   TEXT PRIMARY KEY,
  order_gid            TEXT NOT NULL,
  return_line_item_gid TEXT NOT NULL,
  unit_id              TEXT,
  typed_ref            TEXT NOT NULL,
  actor_type           TEXT NOT NULL,
  actor_id             TEXT,
  created_at           INTEGER NOT NULL
);
CREATE INDEX return_identifications_order ON return_identifications (order_gid);

-- Last Shopify quantities read for a tracked item at a location (sync_inventory_level, R3, unit creation).
CREATE TABLE inventory_levels (
  tracked_item_id TEXT NOT NULL,
  location_id     TEXT NOT NULL,
  active          INTEGER NOT NULL CHECK (active IN (0, 1)),
  on_hand         INTEGER NOT NULL,
  available       INTEGER NOT NULL,
  committed       INTEGER NOT NULL,
  reserved        INTEGER NOT NULL,
  quality_control INTEGER NOT NULL,
  damaged         INTEGER NOT NULL,
  safety_stock    INTEGER NOT NULL,
  read_at         INTEGER NOT NULL,
  -- Start of an unexplained gap (grace period S-22, 8.1); null when the invariants hold.
  gap_since       INTEGER,
  PRIMARY KEY (tracked_item_id, location_id)
) WITHOUT ROWID;

CREATE TABLE imports (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('units_csv', 'serialogic_json', 'generic_csv')),
  status      TEXT NOT NULL CHECK (status IN ('uploaded', 'validating', 'validated', 'importing', 'done', 'failed')),
  file_key    TEXT,
  -- MVP: parsed rows kept in the base (at most 5 000), instead of an R2 file (workers/DECISIONS.md).
  rows        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(rows)),
  mapping     TEXT CHECK (mapping IS NULL OR json_valid(mapping)),
  report      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(report)),
  rows_total  INTEGER NOT NULL DEFAULT 0,
  rows_ok     INTEGER NOT NULL DEFAULT 0,
  rows_failed INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- `Idempotency-Key` replays of the API (14.1), 24 h.
CREATE TABLE api_idempotency (
  key          TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status_code  INTEGER NOT NULL,
  response     TEXT NOT NULL,
  headers      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(headers)),
  expires_at   INTEGER NOT NULL
);
CREATE INDEX api_idempotency_expiry ON api_idempotency (expires_at);

-- Outbox: start of the stale-quantity revisions of a row (12.4: revisions go on for 10 minutes).
ALTER TABLE outbox ADD COLUMN stale_since INTEGER;
