-- Global registry (D1 `registry`, jurisdiction eu) — spec section 11.1.
CREATE TABLE shops (
  shop_domain     TEXT PRIMARY KEY,
  object_name     TEXT NOT NULL,
  jurisdiction    TEXT,             -- 'eu' or NULL (location hint used instead, spec 10.5)
  location_hint   TEXT,
  status          TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'frozen')),
  installed_at    TEXT NOT NULL,
  uninstalled_at  TEXT
);

-- Global kill switch and other flags (P-02).
CREATE TABLE flags (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO flags (key, value, updated_at) VALUES ('emergency_stop', '0', '1970-01-01T00:00:00Z');
