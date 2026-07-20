-- Structural half of the v1 -> v2 migration. initializeTaproot() must run
-- immediately afterward to SHA-256 backfill legacy revisions, create their
-- audit events, install immutability triggers, and verify version metadata.
ALTER TABLE taproot_entity_revisions ADD COLUMN attribution_json TEXT CHECK (attribution_json IS NULL OR json_valid(attribution_json));
ALTER TABLE taproot_entity_revisions ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json));
ALTER TABLE taproot_entity_revisions ADD COLUMN event_id TEXT;
ALTER TABLE taproot_entity_revisions ADD COLUMN content_hash TEXT;
ALTER TABLE taproot_entity_revisions ADD COLUMN parent_hash TEXT;
ALTER TABLE taproot_entity_revisions ADD COLUMN deleted_at TEXT;
ALTER TABLE taproot_entity_revisions ADD COLUMN redirect_to TEXT;

CREATE TABLE taproot_audit_events (
  event_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('create', 'update', 'revert', 'delete', 'restore', 'redirect', 'import', 'repair')),
  attribution_json TEXT CHECK (attribution_json IS NULL OR json_valid(attribution_json)),
  edit_summary TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  request_id TEXT,
  content_hash TEXT NOT NULL,
  parent_hash TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (entity_id, revision) REFERENCES taproot_entity_revisions(entity_id, revision)
) STRICT;

CREATE TABLE taproot_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE taproot_rdf_ownership (
  entity_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  predicate_key TEXT NOT NULL,
  object_key TEXT NOT NULL,
  graph_key TEXT NOT NULL,
  PRIMARY KEY (entity_id, subject_key, predicate_key, object_key, graph_key),
  FOREIGN KEY (entity_id) REFERENCES taproot_entities(entity_id)
) STRICT;

CREATE INDEX taproot_audit_entity_idx ON taproot_audit_events(entity_id, revision DESC, event_id);
CREATE INDEX taproot_audit_request_idx ON taproot_audit_events(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX taproot_rdf_ownership_quad_idx ON taproot_rdf_ownership(subject_key, predicate_key, object_key, graph_key, entity_id);

INSERT INTO taproot_migrations(version, name) VALUES (1, 'initial'), (2, 'audit-and-operations');
