-- Documentation copy of package migration 0005.
-- Hosts must use applyTaprootMigrations(); this file is not an independent runner.
-- The migration is DDL-only and intentionally performs no canonical-data backfill.

CREATE TABLE IF NOT EXISTS taproot_unified_search_source_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  installation_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('statement', 'item', 'task', 'memory', 'prompt', 'resource', 'annotation')),
  source_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  change_class TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  authorization_revision INTEGER NOT NULL CHECK (authorization_revision >= 1),
  search_generation INTEGER NOT NULL CHECK (search_generation >= 1),
  predecessor_event_id TEXT,
  predecessor_sequence INTEGER,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((predecessor_event_id IS NULL) = (predecessor_sequence IS NULL)),
  UNIQUE (installation_id, source_kind, source_id, source_revision),
  FOREIGN KEY (predecessor_sequence) REFERENCES taproot_unified_search_source_events(sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS taproot_unified_search_source_registry (
  installation_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('statement', 'item', 'task', 'memory', 'prompt', 'resource', 'annotation')),
  source_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  current_event_id TEXT NOT NULL,
  current_event_sequence INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  change_class TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  authorization_revision INTEGER NOT NULL CHECK (authorization_revision >= 1),
  search_generation INTEGER NOT NULL CHECK (search_generation >= 1),
  payload_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, source_kind, source_id),
  UNIQUE (current_event_id),
  UNIQUE (current_event_sequence),
  FOREIGN KEY (current_event_sequence) REFERENCES taproot_unified_search_source_events(sequence)
) STRICT;

CREATE INDEX IF NOT EXISTS taproot_search_source_events_replay_idx
  ON taproot_unified_search_source_events(installation_id, source_kind, source_id, source_revision, payload_hash);
CREATE INDEX IF NOT EXISTS taproot_search_source_events_sequence_idx
  ON taproot_unified_search_source_events(installation_id, domain, source_kind, sequence);
CREATE INDEX IF NOT EXISTS taproot_search_source_registry_lookup_idx
  ON taproot_unified_search_source_registry(installation_id, domain, source_kind, source_id);

CREATE TRIGGER IF NOT EXISTS taproot_search_source_events_no_update
  BEFORE UPDATE ON taproot_unified_search_source_events
  BEGIN SELECT RAISE(ABORT, 'taproot unified-search source events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS taproot_search_source_events_no_delete
  BEFORE DELETE ON taproot_unified_search_source_events
  BEGIN SELECT RAISE(ABORT, 'taproot unified-search source events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS taproot_search_source_events_no_replace
  BEFORE INSERT ON taproot_unified_search_source_events
  WHEN EXISTS (
    SELECT 1 FROM taproot_unified_search_source_events
    WHERE event_id = NEW.event_id
       OR (installation_id = NEW.installation_id
           AND source_kind = NEW.source_kind
           AND source_id = NEW.source_id
           AND source_revision = NEW.source_revision)
  )
  BEGIN SELECT RAISE(ABORT, 'taproot unified-search source events cannot be replaced'); END;
CREATE TRIGGER IF NOT EXISTS taproot_search_source_events_predecessor_guard
  BEFORE INSERT ON taproot_unified_search_source_events
  WHEN NEW.predecessor_sequence IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM taproot_unified_search_source_events
    WHERE sequence = NEW.predecessor_sequence
      AND event_id = NEW.predecessor_event_id
      AND installation_id = NEW.installation_id
      AND domain = NEW.domain
      AND source_kind = NEW.source_kind
      AND source_id = NEW.source_id
  )
  BEGIN SELECT RAISE(ABORT, 'taproot unified-search source predecessor is invalid'); END;
CREATE TRIGGER IF NOT EXISTS taproot_search_source_registry_event_insert_guard
  BEFORE INSERT ON taproot_unified_search_source_registry
  WHEN NOT EXISTS (
    SELECT 1 FROM taproot_unified_search_source_events
    WHERE sequence = NEW.current_event_sequence
      AND event_id = NEW.current_event_id
      AND installation_id = NEW.installation_id
      AND domain = NEW.domain
      AND source_kind = NEW.source_kind
      AND source_id = NEW.source_id
      AND operation = NEW.operation
      AND change_class = NEW.change_class
      AND source_revision = NEW.source_revision
      AND source_hash = NEW.source_hash
      AND authorization_revision = NEW.authorization_revision
      AND search_generation = NEW.search_generation
      AND payload_hash = NEW.payload_hash
      AND created_at = NEW.updated_at
  )
  BEGIN SELECT RAISE(ABORT, 'taproot unified-search source registry event is invalid'); END;
CREATE TRIGGER IF NOT EXISTS taproot_search_source_registry_event_update_guard
  BEFORE UPDATE ON taproot_unified_search_source_registry
  WHEN NOT EXISTS (
    SELECT 1 FROM taproot_unified_search_source_events
    WHERE sequence = NEW.current_event_sequence
      AND event_id = NEW.current_event_id
      AND installation_id = NEW.installation_id
      AND domain = NEW.domain
      AND source_kind = NEW.source_kind
      AND source_id = NEW.source_id
      AND operation = NEW.operation
      AND change_class = NEW.change_class
      AND source_revision = NEW.source_revision
      AND source_hash = NEW.source_hash
      AND authorization_revision = NEW.authorization_revision
      AND search_generation = NEW.search_generation
      AND payload_hash = NEW.payload_hash
      AND created_at = NEW.updated_at
  )
  BEGIN SELECT RAISE(ABORT, 'taproot unified-search source registry event is invalid'); END;
CREATE TRIGGER IF NOT EXISTS taproot_search_source_registry_identity_no_update
  BEFORE UPDATE OF installation_id, source_kind, source_id, domain
  ON taproot_unified_search_source_registry
  BEGIN SELECT RAISE(ABORT, 'taproot unified-search source ownership is immutable'); END;
CREATE TRIGGER IF NOT EXISTS taproot_search_source_registry_no_delete
  BEFORE DELETE ON taproot_unified_search_source_registry
  BEGIN SELECT RAISE(ABORT, 'taproot unified-search source registry is durable'); END;
CREATE TRIGGER IF NOT EXISTS taproot_search_source_registry_sequence_guard
  BEFORE UPDATE ON taproot_unified_search_source_registry
  WHEN NEW.current_event_sequence <= OLD.current_event_sequence
    OR NEW.search_generation <= OLD.search_generation
  BEGIN SELECT RAISE(ABORT, 'taproot unified-search source registry must advance'); END;

INSERT INTO taproot_metadata(metadata_key, metadata_value)
VALUES ('schema_version', '4')
ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value;
INSERT INTO taproot_migrations(version, name)
VALUES (5, 'unified-search-source-events')
ON CONFLICT(version) DO NOTHING;
