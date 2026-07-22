-- Documentation copy of package migration 0006.
-- Hosts must use applyTaprootMigrations(); this file is DDL-only and performs no backfill.

CREATE TABLE IF NOT EXISTS taproot_search_installation_state (
    installation_id TEXT PRIMARY KEY,
    active_corpus_id TEXT NOT NULL UNIQUE,
    shadow_corpus_id TEXT UNIQUE,
    cursor_generation INTEGER NOT NULL DEFAULT 1 CHECK (cursor_generation >= 1),
    lifecycle_generation INTEGER NOT NULL DEFAULT 1 CHECK (lifecycle_generation >= 1),
    health_code TEXT NOT NULL CHECK (health_code IN ('blocked-producers', 'building', 'ready', 'degraded')),
    blocked_producer_count INTEGER NOT NULL DEFAULT 5 CHECK (blocked_producer_count BETWEEN 0 AND 5),
    last_error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_search_corpora (
    corpus_id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    corpus_generation INTEGER NOT NULL CHECK (corpus_generation >= 1),
    role TEXT NOT NULL CHECK (role IN ('active', 'shadow', 'retired')),
    state TEXT NOT NULL CHECK (state IN ('building', 'ready', 'active', 'retired')),
    source_watermark_sequence INTEGER NOT NULL CHECK (source_watermark_sequence >= 0),
    fanout_start_sequence INTEGER NOT NULL CHECK (fanout_start_sequence >= 0),
    enumeration_cursor TEXT,
    enumeration_complete INTEGER NOT NULL DEFAULT 0 CHECK (enumeration_complete IN (0, 1)),
    manifest_root_count INTEGER NOT NULL DEFAULT 0 CHECK (manifest_root_count >= 0),
    manifest_document_count INTEGER NOT NULL DEFAULT 0 CHECK (manifest_document_count >= 0),
    manifest_chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (manifest_chunk_count >= 0),
    created_at TEXT NOT NULL,
    ready_at TEXT,
    activated_at TEXT,
    UNIQUE (installation_id, corpus_generation)
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_search_kind_checkpoints (
    corpus_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('statement', 'item', 'task', 'memory', 'prompt', 'resource', 'annotation')),
    enqueued_sequence INTEGER NOT NULL DEFAULT 0 CHECK (enqueued_sequence >= 0),
    applied_sequence INTEGER NOT NULL DEFAULT 0 CHECK (applied_sequence >= 0),
    PRIMARY KEY (corpus_id, source_kind),
    FOREIGN KEY (corpus_id) REFERENCES taproot_search_corpora(corpus_id),
    CHECK (applied_sequence <= enqueued_sequence)
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_search_projection_jobs (
    job_id TEXT PRIMARY KEY,
    corpus_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    source_event_sequence INTEGER NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('statement', 'item', 'task', 'memory', 'prompt', 'resource', 'annotation')),
    source_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
    root_revision TEXT NOT NULL,
    root_hash TEXT NOT NULL,
    authorization_revision INTEGER NOT NULL CHECK (authorization_revision >= 1),
    search_generation INTEGER NOT NULL CHECK (search_generation >= 1),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'staged', 'complete', 'dead')),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    claim_token TEXT,
    claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
    lease_expires_at TEXT,
    not_before TEXT NOT NULL,
    last_error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (corpus_id, source_event_sequence),
    UNIQUE (corpus_id, source_event_id),
    FOREIGN KEY (corpus_id) REFERENCES taproot_search_corpora(corpus_id),
    FOREIGN KEY (source_event_sequence) REFERENCES taproot_unified_search_source_events(sequence),
    CHECK ((state IN ('leased', 'staged')) = (claim_token IS NOT NULL)),
    CHECK ((claim_token IS NULL) = (lease_expires_at IS NULL))
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_search_job_transitions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    transition_id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL CHECK (to_state IN ('pending', 'leased', 'staged', 'complete', 'dead')),
    claim_token_hash TEXT,
    attempt INTEGER NOT NULL CHECK (attempt >= 0),
    error_code TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES taproot_search_projection_jobs(job_id)
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_search_stages (
    stage_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    corpus_id TEXT NOT NULL,
    claim_token TEXT NOT NULL,
    claim_generation INTEGER NOT NULL CHECK (claim_generation >= 1),
    state TEXT NOT NULL CHECK (state IN ('building', 'verified', 'committed', 'abandoned')),
    root_kind TEXT NOT NULL CHECK (root_kind IN ('statement', 'item', 'task', 'memory', 'prompt', 'resource', 'annotation')),
    root_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    source_event_sequence INTEGER NOT NULL,
    root_revision TEXT NOT NULL,
    root_hash TEXT NOT NULL,
    authorization_revision INTEGER NOT NULL CHECK (authorization_revision >= 1),
    manifest_hash TEXT,
    page_count INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0),
    document_count INTEGER NOT NULL DEFAULT 0 CHECK (document_count >= 0),
    chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
    created_at TEXT NOT NULL,
    verified_at TEXT,
    committed_at TEXT,
    FOREIGN KEY (job_id) REFERENCES taproot_search_projection_jobs(job_id),
    FOREIGN KEY (corpus_id) REFERENCES taproot_search_corpora(corpus_id)
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_search_stage_pages (
    stage_id TEXT NOT NULL,
    page_ordinal INTEGER NOT NULL CHECK (page_ordinal >= 0),
    first_document_slot TEXT NOT NULL,
    last_document_slot TEXT NOT NULL,
    document_count INTEGER NOT NULL CHECK (document_count BETWEEN 1 AND 100),
    chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 0 AND 51200),
    page_hash TEXT NOT NULL,
    PRIMARY KEY (stage_id, page_ordinal),
    FOREIGN KEY (stage_id) REFERENCES taproot_search_stages(stage_id)
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_search_staged_documents (
    stage_id TEXT NOT NULL,
    document_slot TEXT NOT NULL,
    document_id TEXT NOT NULL,
    document_hash TEXT NOT NULL,
    document_kind TEXT NOT NULL CHECK (document_kind IN ('statement', 'item')),
    root_reference_json TEXT NOT NULL CHECK (json_valid(root_reference_json)),
    canonical_reference_json TEXT NOT NULL CHECK (json_valid(canonical_reference_json)),
    authorization_fingerprint TEXT NOT NULL,
    filter_metadata_json TEXT NOT NULL CHECK (json_valid(filter_metadata_json)),
    document_text TEXT NOT NULL,
    PRIMARY KEY (stage_id, document_slot),
    UNIQUE (stage_id, document_id),
    FOREIGN KEY (stage_id) REFERENCES taproot_search_stages(stage_id)
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_search_document_clauses (
    stage_id TEXT NOT NULL,
    document_slot TEXT NOT NULL,
    clause_ordinal INTEGER NOT NULL CHECK (clause_ordinal >= 0),
    PRIMARY KEY (stage_id, document_slot, clause_ordinal),
    FOREIGN KEY (stage_id, document_slot)
      REFERENCES taproot_search_staged_documents(stage_id, document_slot)
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_search_document_atoms (
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

CREATE TABLE IF NOT EXISTS taproot_search_filter_values (
    stage_id TEXT NOT NULL,
    document_slot TEXT NOT NULL,
    filter_name TEXT NOT NULL CHECK (filter_name IN ('language', 'source_revision', 'predicate_id', 'type_id', 'status', 'media_type')),
    filter_value TEXT NOT NULL,
    PRIMARY KEY (stage_id, document_slot, filter_name, filter_value),
    FOREIGN KEY (stage_id, document_slot)
      REFERENCES taproot_search_staged_documents(stage_id, document_slot)
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_search_chunks (
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

CREATE TABLE IF NOT EXISTS taproot_search_materialization_heads (
    corpus_id TEXT NOT NULL,
    root_kind TEXT NOT NULL,
    root_id TEXT NOT NULL,
    current_stage_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    source_event_sequence INTEGER NOT NULL,
    root_revision TEXT NOT NULL,
    root_hash TEXT NOT NULL,
    authorization_revision INTEGER NOT NULL,
    eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (corpus_id, root_kind, root_id),
    UNIQUE (current_stage_id),
    FOREIGN KEY (corpus_id) REFERENCES taproot_search_corpora(corpus_id),
    FOREIGN KEY (current_stage_id) REFERENCES taproot_search_stages(stage_id)
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_search_materialization_tombstones (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    tombstone_id TEXT NOT NULL UNIQUE,
    corpus_id TEXT NOT NULL,
    root_kind TEXT NOT NULL,
    root_id TEXT NOT NULL,
    removed_stage_id TEXT,
    source_event_id TEXT NOT NULL,
    source_event_sequence INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('replace-all', 'delete', 'stale', 'authorization')),
    created_at TEXT NOT NULL
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_search_rebuild_roots (
    corpus_id TEXT NOT NULL,
    root_kind TEXT NOT NULL,
    root_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    source_event_sequence INTEGER NOT NULL,
    enumerated INTEGER NOT NULL DEFAULT 0 CHECK (enumerated IN (0, 1)),
    PRIMARY KEY (corpus_id, root_kind, root_id),
    FOREIGN KEY (corpus_id) REFERENCES taproot_search_corpora(corpus_id)
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_search_admin_audit (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_id TEXT NOT NULL UNIQUE,
    installation_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('initialize', 'retry', 'rebuild-start', 'rebuild-ready', 'activate')),
    principal_id TEXT NOT NULL,
    corpus_id TEXT NOT NULL,
    details_json TEXT NOT NULL CHECK (json_valid(details_json)),
    created_at TEXT NOT NULL
  ) STRICT;

CREATE INDEX IF NOT EXISTS taproot_search_jobs_claim_pending_idx
    ON taproot_search_projection_jobs(installation_id, state, not_before, source_event_sequence, corpus_id);

CREATE INDEX IF NOT EXISTS taproot_search_jobs_claim_lease_idx
    ON taproot_search_projection_jobs(installation_id, state, lease_expires_at, source_event_sequence, corpus_id);

CREATE INDEX IF NOT EXISTS taproot_search_jobs_source_idx
    ON taproot_search_projection_jobs(installation_id, source_kind, source_id, source_event_sequence);

CREATE INDEX IF NOT EXISTS taproot_search_heads_root_idx
    ON taproot_search_materialization_heads(corpus_id, root_kind, root_id, source_event_sequence);

CREATE INDEX IF NOT EXISTS taproot_search_heads_eligibility_idx
    ON taproot_search_materialization_heads(corpus_id, eligible, root_kind, root_id);

CREATE INDEX IF NOT EXISTS taproot_search_chunks_document_idx
    ON taproot_search_chunks(stage_id, document_slot, ordinal);

CREATE INDEX IF NOT EXISTS taproot_search_filter_lookup_idx
    ON taproot_search_filter_values(filter_name, filter_value, stage_id, document_slot);

CREATE INDEX IF NOT EXISTS taproot_search_atoms_lookup_idx
    ON taproot_search_document_atoms(atom_kind, atom_value, stage_id, document_slot, clause_ordinal);

CREATE INDEX IF NOT EXISTS taproot_search_rebuild_enumeration_idx
    ON taproot_search_rebuild_roots(corpus_id, enumerated, root_kind, root_id);

CREATE INDEX IF NOT EXISTS taproot_search_source_events_root_idx
    ON taproot_unified_search_source_events(installation_id, source_kind, source_id, sequence);

CREATE TRIGGER IF NOT EXISTS taproot_search_jobs_source_guard
    BEFORE INSERT ON taproot_search_projection_jobs
    WHEN NOT EXISTS (
      SELECT 1 FROM taproot_unified_search_source_events
      WHERE sequence = NEW.source_event_sequence
        AND event_id = NEW.source_event_id
        AND installation_id = NEW.installation_id
        AND source_kind = NEW.source_kind
        AND source_id = NEW.source_id
        AND operation = NEW.operation
        AND source_revision = NEW.root_revision
        AND source_hash = NEW.root_hash
        AND authorization_revision = NEW.authorization_revision
        AND search_generation = NEW.search_generation
    )
    BEGIN SELECT RAISE(ABORT, 'taproot search projection job source is invalid'); END;

CREATE TRIGGER IF NOT EXISTS taproot_search_transitions_no_update
    BEFORE UPDATE ON taproot_search_job_transitions
    BEGIN SELECT RAISE(ABORT, 'taproot search job transitions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS taproot_search_transitions_no_delete
    BEFORE DELETE ON taproot_search_job_transitions
    BEGIN SELECT RAISE(ABORT, 'taproot search job transitions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS taproot_search_tombstones_no_update
    BEFORE UPDATE ON taproot_search_materialization_tombstones
    BEGIN SELECT RAISE(ABORT, 'taproot search tombstones are immutable'); END;

CREATE TRIGGER IF NOT EXISTS taproot_search_tombstones_no_delete
    BEFORE DELETE ON taproot_search_materialization_tombstones
    BEGIN SELECT RAISE(ABORT, 'taproot search tombstones are immutable'); END;

CREATE TRIGGER IF NOT EXISTS taproot_search_admin_audit_no_update
    BEFORE UPDATE ON taproot_search_admin_audit
    BEGIN SELECT RAISE(ABORT, 'taproot search admin audit is immutable'); END;

CREATE TRIGGER IF NOT EXISTS taproot_search_admin_audit_no_delete
    BEFORE DELETE ON taproot_search_admin_audit
    BEGIN SELECT RAISE(ABORT, 'taproot search admin audit is immutable'); END;

CREATE TRIGGER IF NOT EXISTS taproot_search_heads_identity_guard
    BEFORE UPDATE OF corpus_id, root_kind, root_id
    ON taproot_search_materialization_heads
    BEGIN SELECT RAISE(ABORT, 'taproot search document identity is immutable'); END;

CREATE TRIGGER IF NOT EXISTS taproot_search_heads_sequence_guard
    BEFORE UPDATE OF source_event_sequence ON taproot_search_materialization_heads
    WHEN NEW.source_event_sequence <= OLD.source_event_sequence
    BEGIN SELECT RAISE(ABORT, 'taproot search materialization head must advance'); END;

CREATE TRIGGER IF NOT EXISTS taproot_search_committed_stage_no_update
    BEFORE UPDATE ON taproot_search_stages
    WHEN OLD.state = 'committed'
    BEGIN SELECT RAISE(ABORT, 'taproot committed search stages are immutable'); END;

INSERT INTO taproot_metadata(metadata_key, metadata_value)
    VALUES ('schema_version', '5')
    ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value;

INSERT INTO taproot_migrations(version, name)
    VALUES (6, 'unified-search-materialization-lifecycle')
    ON CONFLICT(version) DO NOTHING;
