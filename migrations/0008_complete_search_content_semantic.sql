-- Canonical Resource/Annotation and complete hybrid-search administration.
-- Generated from taprootCompleteSearchSchemaStatements; checksum is owned by
-- the namespaced migration ledger in src/migrations.ts.

CREATE TABLE IF NOT EXISTS taproot_resources (
    record_id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
    visibility_json TEXT NOT NULL CHECK (json_valid(visibility_json)),
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_annotations (
    record_id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
    visibility_json TEXT NOT NULL CHECK (json_valid(visibility_json)),
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_content_revisions (
    record_kind TEXT NOT NULL CHECK (record_kind IN ('resource', 'annotation')),
    record_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (record_kind, record_id, revision)
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_content_audit (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_id TEXT NOT NULL UNIQUE,
    installation_id TEXT NOT NULL,
    record_kind TEXT NOT NULL CHECK (record_kind IN ('resource', 'annotation')),
    record_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    event_type TEXT NOT NULL CHECK (event_type IN ('create', 'update', 'delete', 'restore', 'import')),
    principal_id TEXT NOT NULL,
    attribution_json TEXT NOT NULL CHECK (json_valid(attribution_json)),
    record_hash TEXT NOT NULL,
    previous_hash TEXT,
    created_at TEXT NOT NULL
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_semantic_configurations (
    configuration_id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider_kind TEXT NOT NULL CHECK (provider_kind IN ('openai-compatible', 'ollama-compatible')),
    provider_url TEXT NOT NULL,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL CHECK (dimensions > 0),
    metric TEXT NOT NULL CHECK (metric IN ('cosine', 'dot', 'euclid')),
    vector_kind TEXT NOT NULL CHECK (vector_kind IN ('sqlite', 'qdrant')),
    vector_url TEXT,
    fingerprint TEXT NOT NULL,
    selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
    state TEXT NOT NULL CHECK (state IN ('unvalidated', 'validating', 'ready', 'building', 'failed', 'retired', 'deleting')),
    circuit_open INTEGER NOT NULL DEFAULT 0 CHECK (circuit_open IN (0, 1)),
    warning_emitted INTEGER NOT NULL DEFAULT 0 CHECK (warning_emitted IN (0, 1)),
    active_generation INTEGER NOT NULL DEFAULT 1 CHECK (active_generation >= 1),
    ready_generation INTEGER,
    failure_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (installation_id, name),
    CHECK (ready_generation IS NULL OR ready_generation <= active_generation)
  ) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS taproot_semantic_selected_idx
    ON taproot_semantic_configurations(installation_id) WHERE selected = 1;

CREATE TABLE IF NOT EXISTS taproot_embedding_generations (
    configuration_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    state TEXT NOT NULL CHECK (state IN ('planned', 'building', 'ready', 'failed', 'retired')),
    eligible_count INTEGER NOT NULL DEFAULT 0 CHECK (eligible_count >= 0),
    embedded_count INTEGER NOT NULL DEFAULT 0 CHECK (embedded_count >= 0),
    excluded_count INTEGER NOT NULL DEFAULT 0 CHECK (excluded_count >= 0),
    failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    checkpoint TEXT,
    created_at TEXT NOT NULL,
    ready_at TEXT,
    PRIMARY KEY (configuration_id, generation),
    FOREIGN KEY (configuration_id) REFERENCES taproot_semantic_configurations(configuration_id)
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_embedding_vectors (
    configuration_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    installation_id TEXT NOT NULL,
    derived_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('item', 'task', 'memory', 'prompt', 'resource', 'annotation')),
    source_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    document_id TEXT NOT NULL,
    chunk_id TEXT,
    content_hash TEXT NOT NULL,
    authorization_json TEXT NOT NULL CHECK (json_valid(authorization_json)),
    selector_json TEXT CHECK (selector_json IS NULL OR json_valid(selector_json)),
    vector_json TEXT NOT NULL CHECK (json_valid(vector_json)),
    dimensions INTEGER NOT NULL CHECK (dimensions > 0),
    metric TEXT NOT NULL CHECK (metric IN ('cosine', 'dot', 'euclid')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (configuration_id, generation, derived_id)
  ) STRICT;

CREATE INDEX IF NOT EXISTS taproot_embedding_source_idx
    ON taproot_embedding_vectors(installation_id, configuration_id, generation, kind, source_id, source_revision);

CREATE TABLE IF NOT EXISTS taproot_embedding_plans (
    plan_id TEXT PRIMARY KEY,
    configuration_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('estimated', 'approved', 'running', 'paused', 'stopped', 'complete', 'failed')),
    estimate_json TEXT NOT NULL CHECK (json_valid(estimate_json)),
    policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
    principal_id TEXT NOT NULL,
    approved_by TEXT,
    created_at TEXT NOT NULL,
    approved_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (configuration_id) REFERENCES taproot_semantic_configurations(configuration_id)
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_embedding_work (
    plan_id TEXT NOT NULL,
    derived_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'complete', 'failed', 'excluded', 'superseded')),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
    token_count INTEGER NOT NULL DEFAULT 0 CHECK (token_count >= 0),
    failure_code TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (plan_id, derived_id),
    FOREIGN KEY (plan_id) REFERENCES taproot_embedding_plans(plan_id)
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_embedding_usage (
    usage_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    batch_key TEXT NOT NULL,
    day_key TEXT NOT NULL,
    month_key TEXT NOT NULL,
    estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
    actual_tokens INTEGER CHECK (actual_tokens IS NULL OR actual_tokens >= 0),
    reserved_cost_microunits INTEGER,
    actual_cost_microunits INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE (plan_id, batch_key),
    FOREIGN KEY (plan_id) REFERENCES taproot_embedding_plans(plan_id)
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_embedding_exclusions (
    configuration_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    derived_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (configuration_id, generation, derived_id)
  ) STRICT;

CREATE TABLE IF NOT EXISTS taproot_semantic_admin_audit (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_id TEXT NOT NULL UNIQUE,
    installation_id TEXT NOT NULL,
    configuration_id TEXT,
    plan_id TEXT,
    action TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    details_json TEXT NOT NULL CHECK (json_valid(details_json)),
    created_at TEXT NOT NULL
  ) STRICT;

CREATE TRIGGER IF NOT EXISTS taproot_content_audit_no_update
    BEFORE UPDATE ON taproot_content_audit
    BEGIN SELECT RAISE(ABORT, 'taproot content audit is immutable'); END;

CREATE TRIGGER IF NOT EXISTS taproot_content_audit_no_delete
    BEFORE DELETE ON taproot_content_audit
    BEGIN SELECT RAISE(ABORT, 'taproot content audit is immutable'); END;

CREATE TRIGGER IF NOT EXISTS taproot_semantic_admin_audit_no_update
    BEFORE UPDATE ON taproot_semantic_admin_audit
    BEGIN SELECT RAISE(ABORT, 'taproot semantic audit is immutable'); END;

CREATE TRIGGER IF NOT EXISTS taproot_semantic_admin_audit_no_delete
    BEFORE DELETE ON taproot_semantic_admin_audit
    BEGIN SELECT RAISE(ABORT, 'taproot semantic audit is immutable'); END;

INSERT INTO taproot_metadata(metadata_key, metadata_value)
    VALUES ('schema_version', '7')
    ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value;

INSERT INTO taproot_migrations(version, name)
    VALUES (8, 'complete-search-content-semantic')
    ON CONFLICT(version) DO NOTHING;
