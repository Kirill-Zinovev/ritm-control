CREATE TABLE printing_import (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  snapshot_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  catalog_at TEXT,
  manifest TEXT NOT NULL CHECK (json_valid(manifest)),
  manifest_hash TEXT NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1))
) STRICT;
--> statement-breakpoint
CREATE TABLE printing_import_parts (
  kind TEXT NOT NULL,
  part INTEGER NOT NULL,
  digest TEXT NOT NULL,
  insert_token TEXT NOT NULL,
  PRIMARY KEY (kind, part)
) STRICT;
--> statement-breakpoint
CREATE TABLE printing_supplies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  department TEXT NOT NULL CHECK (department IN ('box', 'roll')),
  status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'unknown')),
  sort_order INTEGER NOT NULL,
  market TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX printing_supplies_department ON printing_supplies (department, sort_order);
--> statement-breakpoint
CREATE TABLE printing_positions (
  supply_id TEXT NOT NULL REFERENCES printing_supplies(id),
  row_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  plan REAL,
  printed REAL,
  cut REAL,
  cut_available REAL,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (supply_id, row_id)
) STRICT;
--> statement-breakpoint
CREATE INDEX printing_position_order ON printing_positions (supply_id, sort_order);
--> statement-breakpoint
CREATE TABLE printing_employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE printing_receipts (
  id TEXT PRIMARY KEY,
  supply_id TEXT NOT NULL REFERENCES printing_supplies(id),
  fingerprint TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  outcome TEXT NOT NULL CHECK (json_valid(outcome)),
  facts TEXT NOT NULL CHECK (json_valid(facts)),
  commit_token TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX printing_receipts_supply ON printing_receipts (supply_id, recorded_at DESC);
--> statement-breakpoint
CREATE TABLE printing_catalog_cards (
  id TEXT PRIMARY KEY,
  market TEXT NOT NULL,
  sku TEXT NOT NULL,
  sku_key TEXT NOT NULL,
  store TEXT NOT NULL,
  name TEXT NOT NULL,
  extension TEXT NOT NULL,
  photo TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  import_id TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX printing_catalog_sku ON printing_catalog_cards (market, sku_key);
--> statement-breakpoint
CREATE TABLE printing_catalog_sync (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  updated_at TEXT,
  page INTEGER NOT NULL DEFAULT 0,
  market_offset INTEGER NOT NULL DEFAULT 0,
  import_id TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0
) STRICT;
--> statement-breakpoint
INSERT INTO printing_catalog_sync(singleton) VALUES (1);
--> statement-breakpoint
CREATE TABLE printing_sessions (
  token_hash TEXT PRIMARY KEY,
  department TEXT NOT NULL CHECK (department IN ('box', 'roll')),
  expires_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX printing_session_expiry ON printing_sessions (expires_at);
--> statement-breakpoint
CREATE TABLE printing_login_attempts (
  id TEXT PRIMARY KEY,
  department TEXT NOT NULL CHECK (department IN ('box', 'roll')),
  client TEXT NOT NULL,
  at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX printing_attempts_expiry ON printing_login_attempts (department, at);
