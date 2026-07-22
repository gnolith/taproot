-- Documentation copy of package migration 0007.
-- Hosts must use applyTaprootMigrations(); this file preserves 0006 materialization rows.

DROP TRIGGER IF EXISTS taproot_search_source_events_no_update;

DROP TRIGGER IF EXISTS taproot_search_source_registry_event_insert_guard;

DROP TRIGGER IF EXISTS taproot_search_source_registry_event_update_guard;

DROP TRIGGER IF EXISTS taproot_search_source_registry_sequence_guard;

DROP TRIGGER IF EXISTS taproot_search_committed_stage_no_update;

DROP TRIGGER IF EXISTS taproot_search_jobs_source_guard;

ALTER TABLE taproot_unified_search_source_events
     ADD COLUMN source_policy_revision INTEGER NOT NULL DEFAULT 1
       CHECK (source_policy_revision >= 1);

UPDATE taproot_unified_search_source_events
     SET source_policy_revision = authorization_revision;

ALTER TABLE taproot_unified_search_source_registry
     ADD COLUMN source_policy_revision INTEGER NOT NULL DEFAULT 1
       CHECK (source_policy_revision >= 1);

UPDATE taproot_unified_search_source_registry
     SET source_policy_revision = authorization_revision;

ALTER TABLE taproot_search_projection_jobs
     ADD COLUMN source_policy_revision INTEGER NOT NULL DEFAULT 1
       CHECK (source_policy_revision >= 1);

ALTER TABLE taproot_search_projection_jobs
     ADD COLUMN producer_fingerprint TEXT;

UPDATE taproot_search_projection_jobs
     SET source_policy_revision = authorization_revision,
         producer_fingerprint = CASE
           WHEN source_kind IN ('statement', 'item')
             THEN 'taproot-builtin-projection-v1'
           ELSE NULL END;

ALTER TABLE taproot_search_stages
     ADD COLUMN source_policy_revision INTEGER NOT NULL DEFAULT 1
       CHECK (source_policy_revision >= 1);

ALTER TABLE taproot_search_stages
     ADD COLUMN producer_fingerprint TEXT;

UPDATE taproot_search_stages
     SET source_policy_revision = authorization_revision,
         producer_fingerprint = CASE
           WHEN root_kind IN ('statement', 'item')
             THEN 'taproot-builtin-projection-v1'
           ELSE NULL END;

ALTER TABLE taproot_search_materialization_heads
     ADD COLUMN source_policy_revision INTEGER NOT NULL DEFAULT 1
       CHECK (source_policy_revision >= 1);

ALTER TABLE taproot_search_materialization_heads
     ADD COLUMN producer_fingerprint TEXT;

UPDATE taproot_search_materialization_heads
     SET source_policy_revision = authorization_revision,
         producer_fingerprint = CASE
           WHEN root_kind IN ('statement', 'item')
             THEN 'taproot-builtin-projection-v1'
           ELSE NULL END;

ALTER TABLE taproot_search_installation_state
     RENAME TO taproot_search_installation_state_0006;

CREATE TABLE taproot_search_installation_state (
    installation_id TEXT PRIMARY KEY,
    active_corpus_id TEXT NOT NULL UNIQUE,
    shadow_corpus_id TEXT UNIQUE,
    cursor_generation INTEGER NOT NULL DEFAULT 1 CHECK (cursor_generation >= 1),
    lifecycle_generation INTEGER NOT NULL DEFAULT 1 CHECK (lifecycle_generation >= 1),
    health_code TEXT NOT NULL CHECK (health_code IN ('blocked-producers', 'building', 'ready', 'degraded')),
    blocked_producer_count INTEGER NOT NULL DEFAULT 5 CHECK (blocked_producer_count BETWEEN 0 AND 7),
    last_error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

INSERT INTO taproot_search_installation_state
     SELECT * FROM taproot_search_installation_state_0006;

DROP TABLE taproot_search_installation_state_0006;

DROP INDEX IF EXISTS taproot_search_chunks_document_idx;

DROP INDEX IF EXISTS taproot_search_filter_lookup_idx;

DROP INDEX IF EXISTS taproot_search_atoms_lookup_idx;

ALTER TABLE taproot_search_staged_documents
     RENAME TO taproot_search_staged_documents_0006;

ALTER TABLE taproot_search_document_clauses
     RENAME TO taproot_search_document_clauses_0006;

ALTER TABLE taproot_search_document_atoms
     RENAME TO taproot_search_document_atoms_0006;

ALTER TABLE taproot_search_filter_values
     RENAME TO taproot_search_filter_values_0006;

ALTER TABLE taproot_search_chunks
     RENAME TO taproot_search_chunks_0006;

CREATE TABLE taproot_search_staged_documents (
    stage_id TEXT NOT NULL,
    document_slot TEXT NOT NULL,
    document_id TEXT NOT NULL,
    document_hash TEXT NOT NULL,
    document_kind TEXT NOT NULL CHECK (document_kind IN ('statement', 'item', 'task', 'memory', 'prompt', 'resource', 'annotation')),
    root_reference_json TEXT NOT NULL CHECK (json_valid(root_reference_json)),
    canonical_reference_json TEXT NOT NULL CHECK (json_valid(canonical_reference_json)),
    authorization_fingerprint TEXT NOT NULL,
    filter_metadata_json TEXT NOT NULL CHECK (json_valid(filter_metadata_json)),
    document_text TEXT NOT NULL,
    PRIMARY KEY (stage_id, document_slot),
    UNIQUE (stage_id, document_id),
    FOREIGN KEY (stage_id) REFERENCES taproot_search_stages(stage_id)
  ) STRICT;

CREATE TABLE taproot_search_document_clauses (
    stage_id TEXT NOT NULL,
    document_slot TEXT NOT NULL,
    clause_ordinal INTEGER NOT NULL CHECK (clause_ordinal >= 0),
    PRIMARY KEY (stage_id, document_slot, clause_ordinal),
    FOREIGN KEY (stage_id, document_slot)
      REFERENCES taproot_search_staged_documents(stage_id, document_slot)
  ) STRICT;

CREATE TABLE taproot_search_document_atoms (
    stage_id TEXT NOT NULL,
    document_slot TEXT NOT NULL,
    clause_ordinal INTEGER NOT NULL,
    atom_ordinal INTEGER NOT NULL CHECK (atom_ordinal >= 0),
    atom_kind TEXT NOT NULL CHECK (atom_kind IN ('public', 'principal', 'workspace', 'capability')),
    atom_value TEXT,
    PRIMARY KEY (stage_id, document_slot, clause_ordinal, atom_ordinal),
    FOREIGN KEY (stage_id, document_slot, clause_ordinal)
      REFERENCES taproot_search_document_clauses(stage_id, document_slot, clause_ordinal),
    CHECK ((atom_kind = 'public') = (atom_value IS NULL))
  ) STRICT;

CREATE TABLE taproot_search_filter_values (
    stage_id TEXT NOT NULL,
    document_slot TEXT NOT NULL,
    filter_name TEXT NOT NULL CHECK (filter_name IN ('language', 'source_revision', 'predicate_id', 'type_id', 'status', 'media_type')),
    filter_value TEXT NOT NULL,
    PRIMARY KEY (stage_id, document_slot, filter_name, filter_value),
    FOREIGN KEY (stage_id, document_slot)
      REFERENCES taproot_search_staged_documents(stage_id, document_slot)
  ) STRICT;

CREATE TABLE taproot_search_chunks (
    stage_id TEXT NOT NULL,
    document_slot TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    chunk_hash TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 511),
    document_start INTEGER NOT NULL CHECK (document_start >= 0),
    document_end INTEGER NOT NULL CHECK (document_end >= document_start),
    chunk_text TEXT NOT NULL,
    trace_json TEXT NOT NULL CHECK (json_valid(trace_json)),
    PRIMARY KEY (stage_id, document_slot, ordinal),
    UNIQUE (stage_id, chunk_id),
    FOREIGN KEY (stage_id, document_slot)
      REFERENCES taproot_search_staged_documents(stage_id, document_slot)
  ) STRICT;

INSERT INTO taproot_search_staged_documents
     SELECT * FROM taproot_search_staged_documents_0006;

INSERT INTO taproot_search_document_clauses
     SELECT * FROM taproot_search_document_clauses_0006;

INSERT INTO taproot_search_document_atoms
     SELECT * FROM taproot_search_document_atoms_0006;

INSERT INTO taproot_search_filter_values
     SELECT * FROM taproot_search_filter_values_0006;

INSERT INTO taproot_search_chunks
     SELECT * FROM taproot_search_chunks_0006;

DROP TABLE taproot_search_document_atoms_0006;

DROP TABLE taproot_search_document_clauses_0006;

DROP TABLE taproot_search_filter_values_0006;

DROP TABLE taproot_search_chunks_0006;

DROP TABLE taproot_search_staged_documents_0006;

CREATE INDEX taproot_search_chunks_document_idx
    ON taproot_search_chunks(stage_id, document_slot, ordinal);

CREATE INDEX taproot_search_filter_lookup_idx
    ON taproot_search_filter_values(filter_name, filter_value, stage_id, document_slot);

CREATE INDEX taproot_search_atoms_lookup_idx
    ON taproot_search_document_atoms(atom_kind, atom_value, stage_id, document_slot, clause_ordinal);

CREATE TABLE taproot_unified_search_producer_manifests (
    installation_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('statement', 'item', 'task', 'memory', 'prompt', 'resource', 'annotation')),
    producer_fingerprint TEXT NOT NULL,
    owning_domain TEXT NOT NULL,
    contract_version TEXT NOT NULL,
    projection_version TEXT NOT NULL,
    authorization_contract_version TEXT NOT NULL,
    manifest_revision INTEGER NOT NULL CHECK (manifest_revision >= 1),
    created_at TEXT NOT NULL,
    PRIMARY KEY (installation_id, source_kind, producer_fingerprint),
    UNIQUE (installation_id, source_kind, manifest_revision),
    CHECK ((source_kind IN ('statement', 'item', 'resource', 'annotation') AND owning_domain = 'taproot')
      OR (source_kind IN ('task', 'memory', 'prompt') AND owning_domain = 'workshop'))
  ) STRICT;

CREATE TABLE taproot_unified_search_producer_adoptions (
    installation_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('statement', 'item', 'task', 'memory', 'prompt', 'resource', 'annotation')),
    producer_fingerprint TEXT,
    state TEXT NOT NULL CHECK (state IN ('backfilling', 'ready', 'blocked', 'failed', 'retired')),
    opaque_cursor TEXT,
    enumerated_count INTEGER NOT NULL DEFAULT 0 CHECK (enumerated_count >= 0),
    adopted_count INTEGER NOT NULL DEFAULT 0 CHECK (adopted_count >= 0),
    manifest_revision INTEGER NOT NULL DEFAULT 1 CHECK (manifest_revision >= 1),
    last_error_code TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (installation_id, source_kind),
    CHECK (adopted_count <= enumerated_count),
    CHECK ((state = 'blocked') = (producer_fingerprint IS NULL))
  ) STRICT;

CREATE TABLE taproot_unified_search_generation_producers (
    corpus_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('statement', 'item', 'task', 'memory', 'prompt', 'resource', 'annotation')),
    producer_fingerprint TEXT,
    contract_version TEXT,
    projection_version TEXT,
    authorization_contract_version TEXT,
    state TEXT NOT NULL CHECK (state IN ('ready', 'blocked', 'retired')),
    checkpoint_json TEXT CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json)),
    checkpoint_count INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_count >= 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (corpus_id, source_kind),
    FOREIGN KEY (corpus_id) REFERENCES taproot_search_corpora(corpus_id),
    CHECK ((state = 'ready') = (producer_fingerprint IS NOT NULL))
  ) STRICT;

CREATE TABLE taproot_unified_search_producer_admin_audit (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_id TEXT NOT NULL UNIQUE,
    installation_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('statement', 'item', 'task', 'memory', 'prompt', 'resource', 'annotation')),
    event_type TEXT NOT NULL CHECK (event_type IN ('register', 'adoption-start', 'adoption-page', 'adoption-ready', 'adoption-blocked', 'adoption-failed', 'fingerprint-switch', 'retire')),
    producer_fingerprint TEXT,
    previous_producer_fingerprint TEXT,
    manifest_revision INTEGER NOT NULL CHECK (manifest_revision >= 1),
    principal_id TEXT NOT NULL,
    details_json TEXT NOT NULL CHECK (json_valid(details_json)),
    created_at TEXT NOT NULL
  ) STRICT;

CREATE INDEX taproot_search_producer_adoption_state_idx
    ON taproot_unified_search_producer_adoptions(installation_id, state, source_kind);

CREATE INDEX taproot_search_generation_producer_state_idx
    ON taproot_unified_search_generation_producers(installation_id, state, source_kind, corpus_id);

CREATE TRIGGER taproot_search_producer_manifests_no_update
    BEFORE UPDATE ON taproot_unified_search_producer_manifests
    BEGIN SELECT RAISE(ABORT, 'taproot search producer manifests are immutable'); END;

CREATE TRIGGER taproot_search_producer_manifests_no_delete
    BEFORE DELETE ON taproot_unified_search_producer_manifests
    BEGIN SELECT RAISE(ABORT, 'taproot search producer manifests are durable'); END;

CREATE TRIGGER taproot_search_producer_audit_no_update
    BEFORE UPDATE ON taproot_unified_search_producer_admin_audit
    BEGIN SELECT RAISE(ABORT, 'taproot search producer audit is immutable'); END;

CREATE TRIGGER taproot_search_producer_audit_no_delete
    BEFORE DELETE ON taproot_unified_search_producer_admin_audit
    BEGIN SELECT RAISE(ABORT, 'taproot search producer audit is immutable'); END;

INSERT INTO taproot_unified_search_producer_manifests(
     installation_id, source_kind, producer_fingerprint, owning_domain,
     contract_version, projection_version, authorization_contract_version,
     manifest_revision, created_at)
   SELECT installation_id, kind, 'taproot-builtin-projection-v1', 'taproot',
          'taproot-external-search-producer-v1',
          'taproot-unified-search-projection-v1',
          'taproot-search-authorization-v1', 1, updated_at
   FROM taproot_installation_authorization
   CROSS JOIN (SELECT 'statement' AS kind UNION ALL SELECT 'item');

INSERT INTO taproot_unified_search_producer_adoptions(
       installation_id, source_kind, producer_fingerprint, state,
       manifest_revision, updated_at)
     SELECT installation_id, 'statement',
       'taproot-builtin-projection-v1', 'ready',
       1, updated_at FROM taproot_installation_authorization;

INSERT INTO taproot_unified_search_producer_adoptions(
       installation_id, source_kind, producer_fingerprint, state,
       manifest_revision, updated_at)
     SELECT installation_id, 'item',
       'taproot-builtin-projection-v1', 'ready',
       1, updated_at FROM taproot_installation_authorization;

INSERT INTO taproot_unified_search_producer_adoptions(
       installation_id, source_kind, producer_fingerprint, state,
       manifest_revision, updated_at)
     SELECT installation_id, 'task',
       NULL, 'blocked',
       1, updated_at FROM taproot_installation_authorization;

INSERT INTO taproot_unified_search_producer_adoptions(
       installation_id, source_kind, producer_fingerprint, state,
       manifest_revision, updated_at)
     SELECT installation_id, 'memory',
       NULL, 'blocked',
       1, updated_at FROM taproot_installation_authorization;

INSERT INTO taproot_unified_search_producer_adoptions(
       installation_id, source_kind, producer_fingerprint, state,
       manifest_revision, updated_at)
     SELECT installation_id, 'prompt',
       NULL, 'blocked',
       1, updated_at FROM taproot_installation_authorization;

INSERT INTO taproot_unified_search_producer_adoptions(
       installation_id, source_kind, producer_fingerprint, state,
       manifest_revision, updated_at)
     SELECT installation_id, 'resource',
       NULL, 'blocked',
       1, updated_at FROM taproot_installation_authorization;

INSERT INTO taproot_unified_search_producer_adoptions(
       installation_id, source_kind, producer_fingerprint, state,
       manifest_revision, updated_at)
     SELECT installation_id, 'annotation',
       NULL, 'blocked',
       1, updated_at FROM taproot_installation_authorization;

INSERT INTO taproot_unified_search_generation_producers(
       corpus_id, installation_id, source_kind, producer_fingerprint,
       contract_version, projection_version, authorization_contract_version,
       state, updated_at)
     SELECT corpus_id, installation_id, 'statement',
       'taproot-builtin-projection-v1', 'taproot-external-search-producer-v1', 'taproot-unified-search-projection-v1', 'taproot-search-authorization-v1', 'ready',
       created_at FROM taproot_search_corpora;

INSERT INTO taproot_unified_search_generation_producers(
       corpus_id, installation_id, source_kind, producer_fingerprint,
       contract_version, projection_version, authorization_contract_version,
       state, updated_at)
     SELECT corpus_id, installation_id, 'item',
       'taproot-builtin-projection-v1', 'taproot-external-search-producer-v1', 'taproot-unified-search-projection-v1', 'taproot-search-authorization-v1', 'ready',
       created_at FROM taproot_search_corpora;

INSERT INTO taproot_unified_search_generation_producers(
       corpus_id, installation_id, source_kind, producer_fingerprint,
       contract_version, projection_version, authorization_contract_version,
       state, updated_at)
     SELECT corpus_id, installation_id, 'task',
       NULL, NULL, NULL, NULL, 'blocked',
       created_at FROM taproot_search_corpora;

INSERT INTO taproot_unified_search_generation_producers(
       corpus_id, installation_id, source_kind, producer_fingerprint,
       contract_version, projection_version, authorization_contract_version,
       state, updated_at)
     SELECT corpus_id, installation_id, 'memory',
       NULL, NULL, NULL, NULL, 'blocked',
       created_at FROM taproot_search_corpora;

INSERT INTO taproot_unified_search_generation_producers(
       corpus_id, installation_id, source_kind, producer_fingerprint,
       contract_version, projection_version, authorization_contract_version,
       state, updated_at)
     SELECT corpus_id, installation_id, 'prompt',
       NULL, NULL, NULL, NULL, 'blocked',
       created_at FROM taproot_search_corpora;

INSERT INTO taproot_unified_search_generation_producers(
       corpus_id, installation_id, source_kind, producer_fingerprint,
       contract_version, projection_version, authorization_contract_version,
       state, updated_at)
     SELECT corpus_id, installation_id, 'resource',
       NULL, NULL, NULL, NULL, 'blocked',
       created_at FROM taproot_search_corpora;

INSERT INTO taproot_unified_search_generation_producers(
       corpus_id, installation_id, source_kind, producer_fingerprint,
       contract_version, projection_version, authorization_contract_version,
       state, updated_at)
     SELECT corpus_id, installation_id, 'annotation',
       NULL, NULL, NULL, NULL, 'blocked',
       created_at FROM taproot_search_corpora;

CREATE TRIGGER taproot_search_source_events_no_update
    BEFORE UPDATE ON taproot_unified_search_source_events
    BEGIN SELECT RAISE(ABORT, 'taproot unified-search source events are immutable'); END;

CREATE TRIGGER taproot_search_source_registry_event_update_guard
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
        AND source_policy_revision = NEW.source_policy_revision
        AND authorization_revision = NEW.authorization_revision
        AND search_generation = NEW.search_generation
        AND payload_hash = NEW.payload_hash
        AND created_at = NEW.updated_at
    )
    BEGIN SELECT RAISE(ABORT, 'taproot unified-search source registry event is invalid'); END;

CREATE TRIGGER taproot_search_source_registry_event_insert_guard
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
        AND source_policy_revision = NEW.source_policy_revision
        AND authorization_revision = NEW.authorization_revision
        AND search_generation = NEW.search_generation
        AND payload_hash = NEW.payload_hash
        AND created_at = NEW.updated_at
    )
    BEGIN SELECT RAISE(ABORT, 'taproot unified-search source registry event is invalid'); END;

CREATE TRIGGER taproot_search_source_registry_sequence_guard
    BEFORE UPDATE ON taproot_unified_search_source_registry
    WHEN NEW.current_event_sequence <= OLD.current_event_sequence
      OR NEW.search_generation <= OLD.search_generation
    BEGIN SELECT RAISE(ABORT, 'taproot unified-search source registry must advance'); END;

CREATE TRIGGER taproot_search_committed_stage_no_update
    BEFORE UPDATE ON taproot_search_stages
    WHEN OLD.state = 'committed'
    BEGIN SELECT RAISE(ABORT, 'taproot committed search stages are immutable'); END;

CREATE TRIGGER taproot_search_jobs_source_guard
    BEFORE INSERT ON taproot_search_projection_jobs
    WHEN NOT EXISTS (
      SELECT 1 FROM taproot_unified_search_source_events e
      JOIN taproot_unified_search_generation_producers p
        ON p.corpus_id = NEW.corpus_id AND p.source_kind = NEW.source_kind
       AND p.installation_id = NEW.installation_id
      WHERE e.sequence = NEW.source_event_sequence
        AND e.event_id = NEW.source_event_id
        AND e.installation_id = NEW.installation_id
        AND e.source_kind = NEW.source_kind
        AND e.source_id = NEW.source_id
        AND e.operation = NEW.operation
        AND e.source_revision = NEW.root_revision
        AND e.source_hash = NEW.root_hash
        AND e.source_policy_revision = NEW.source_policy_revision
        AND e.authorization_revision = NEW.authorization_revision
        AND e.search_generation = NEW.search_generation
        AND p.state = 'ready'
        AND p.producer_fingerprint = NEW.producer_fingerprint
    )
    BEGIN SELECT RAISE(ABORT, 'taproot search projection job source is invalid'); END;

INSERT INTO taproot_metadata(metadata_key, metadata_value)
    VALUES ('schema_version', '6')
    ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value;

INSERT INTO taproot_migrations(version, name)
    VALUES (7, 'external-search-producers')
    ON CONFLICT(version) DO NOTHING;
