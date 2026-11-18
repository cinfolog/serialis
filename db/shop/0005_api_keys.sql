-- Shop database: API keys of the public API (spec 11.2 `api_keys`, 14.1).
-- Additive only (spec 10.4). Timestamps in ms UTC; JSON in TEXT checked by json_valid.
-- Only the SHA-256 of the secret is stored (`hash`, 32 bytes); the full key is shown once at creation.
-- The key's public part (`srl_<version>_<location>_<shop>_<prefix>_<seal>`) is sealed by the Worker
-- secret of `seal_version`; the object looks the key up by `prefix`.

CREATE TABLE api_keys (
  prefix       TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  hash         BLOB NOT NULL CHECK (length(hash) = 32),
  scopes       TEXT NOT NULL CHECK (json_valid(scopes)),
  seal_version INTEGER NOT NULL,
  location     TEXT NOT NULL CHECK (location IN ('eu', 'global')),
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX api_keys_created ON api_keys (created_at);
