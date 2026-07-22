import {
  encodeTerm,
  prepareQuadPatch,
  type SqliteDatabaseLike,
} from '@gnolith/diamond';
import { DataFactory } from 'rdf-data-factory';
import { parseEntityJson } from './canonical.js';
import { buildEntityQuads } from './rdf.js';
import type { EntityId, WikibaseEntity } from './types.js';
import { SchemaMismatchError } from './errors.js';

export const TAPROOT_SCHEMA_VERSION = '6';
export const TAPROOT_JSON_VERSION = '2';
export const TAPROOT_RDF_VERSION = '2';

const PRE_AUTHORIZATION_SCHEMA_VERSION = '2';
const PRE_SEARCH_SOURCE_SCHEMA_VERSION = '3';
const PRE_SEARCH_MATERIALIZATION_SCHEMA_VERSION = '4';
const PRE_EXTERNAL_SEARCH_PRODUCER_SCHEMA_VERSION = '5';

const preAuthorizationTaprootSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS taproot_entities (
    entity_id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('item', 'property')),
    datatype TEXT,
    revision INTEGER NOT NULL,
    entity_json TEXT NOT NULL CHECK (json_valid(entity_json)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    modified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,
    redirect_to TEXT,
    CHECK ((entity_type = 'item' AND datatype IS NULL)
      OR (entity_type = 'property' AND datatype IS NOT NULL))
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_entity_revisions (
    entity_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    entity_json TEXT NOT NULL CHECK (json_valid(entity_json)),
    actor TEXT,
    attribution_json TEXT CHECK (attribution_json IS NULL OR json_valid(attribution_json)),
    edit_summary TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
    event_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    parent_hash TEXT,
    deleted_at TEXT,
    redirect_to TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (entity_id, revision),
    FOREIGN KEY (entity_id) REFERENCES taproot_entities(entity_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_audit_events (
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
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_rdf_ownership (
    entity_id TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    predicate_key TEXT NOT NULL,
    object_key TEXT NOT NULL,
    graph_key TEXT NOT NULL,
    PRIMARY KEY (entity_id, subject_key, predicate_key, object_key, graph_key),
    FOREIGN KEY (entity_id) REFERENCES taproot_entities(entity_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_id_counters (
    entity_type TEXT PRIMARY KEY CHECK (entity_type IN ('item', 'property')),
    next_numeric_id INTEGER NOT NULL CHECK (next_numeric_id > 0)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_terms (
    entity_id TEXT NOT NULL,
    language TEXT NOT NULL,
    term_type TEXT NOT NULL CHECK (term_type IN ('label', 'description', 'alias')),
    value TEXT NOT NULL,
    ordinal INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (entity_id, language, term_type, ordinal),
    FOREIGN KEY (entity_id) REFERENCES taproot_entities(entity_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_metadata (
    metadata_key TEXT PRIMARY KEY,
    metadata_value TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_assertions (
    assertion_key TEXT PRIMARY KEY
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS taproot_entities_type_idx
    ON taproot_entities(entity_type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS taproot_entities_modified_idx
    ON taproot_entities(modified_at, entity_id)`,
  `CREATE INDEX IF NOT EXISTS taproot_revisions_entity_idx
    ON taproot_entity_revisions(entity_id, revision DESC)`,
  `CREATE INDEX IF NOT EXISTS taproot_terms_lookup_idx
    ON taproot_terms(language, value COLLATE NOCASE, entity_id)`,
  `CREATE INDEX IF NOT EXISTS taproot_audit_entity_idx
    ON taproot_audit_events(entity_id, revision DESC, event_id)`,
  `CREATE INDEX IF NOT EXISTS taproot_audit_request_idx
    ON taproot_audit_events(request_id) WHERE request_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS taproot_rdf_ownership_quad_idx
    ON taproot_rdf_ownership(subject_key, predicate_key, object_key, graph_key, entity_id)`,
  `CREATE TRIGGER IF NOT EXISTS taproot_revisions_no_update
    BEFORE UPDATE ON taproot_entity_revisions BEGIN SELECT RAISE(ABORT, 'taproot revisions are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_revisions_no_delete
    BEFORE DELETE ON taproot_entity_revisions BEGIN SELECT RAISE(ABORT, 'taproot revisions are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_audit_no_update
    BEFORE UPDATE ON taproot_audit_events BEGIN SELECT RAISE(ABORT, 'taproot audit events are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_audit_no_delete
    BEFORE DELETE ON taproot_audit_events BEGIN SELECT RAISE(ABORT, 'taproot audit events are immutable'); END`,
  `INSERT INTO taproot_id_counters(entity_type, next_numeric_id)
    VALUES ('item', 1), ('property', 1)
    ON CONFLICT(entity_type) DO NOTHING`,
  `INSERT INTO taproot_metadata(metadata_key, metadata_value)
    VALUES
      ('schema_version', '${PRE_AUTHORIZATION_SCHEMA_VERSION}'),
      ('canonical_json_version', '${TAPROOT_JSON_VERSION}'),
      ('rdf_mapping_version', '${TAPROOT_RDF_VERSION}')
    ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value`,
  `INSERT INTO taproot_migrations(version, name) VALUES (1, 'initial'), (2, 'audit-and-operations'), (3, 'canonical-statement-text')
    ON CONFLICT(version) DO NOTHING`,
] as const;

/** Additive canonical authorization catalog introduced by migration 0004. */
export const taprootAuthorizationSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS taproot_installation_authorization (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    installation_id TEXT NOT NULL UNIQUE,
    authorization_revision INTEGER NOT NULL CHECK (authorization_revision >= 1),
    search_generation INTEGER NOT NULL CHECK (search_generation >= 1),
    last_advance_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_entity_authorization (
    entity_id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    workspace_id TEXT,
    owner_principal_id TEXT NOT NULL,
    visibility_json TEXT NOT NULL CHECK (json_valid(visibility_json)),
    effective_visibility_json TEXT NOT NULL CHECK (json_valid(effective_visibility_json)),
    source_revision INTEGER NOT NULL,
    authorization_revision INTEGER NOT NULL,
    deleted_at TEXT,
    event_id TEXT NOT NULL UNIQUE,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (entity_id) REFERENCES taproot_entities(entity_id),
    FOREIGN KEY (event_id) REFERENCES taproot_audit_events(event_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_entity_authorization_revisions (
    entity_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL,
    installation_id TEXT NOT NULL,
    workspace_id TEXT,
    owner_principal_id TEXT NOT NULL,
    visibility_json TEXT NOT NULL CHECK (json_valid(visibility_json)),
    effective_visibility_json TEXT NOT NULL CHECK (json_valid(effective_visibility_json)),
    authorization_revision INTEGER NOT NULL,
    deleted_at TEXT,
    event_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (entity_id, source_revision),
    FOREIGN KEY (entity_id, source_revision)
      REFERENCES taproot_entity_revisions(entity_id, revision),
    FOREIGN KEY (event_id) REFERENCES taproot_audit_events(event_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_statement_authorization (
    entity_id TEXT NOT NULL,
    statement_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL,
    restrictions_json TEXT NOT NULL CHECK (json_valid(restrictions_json)),
    effective_visibility_json TEXT NOT NULL CHECK (json_valid(effective_visibility_json)),
    authorization_revision INTEGER NOT NULL,
    PRIMARY KEY (entity_id, statement_id),
    FOREIGN KEY (entity_id) REFERENCES taproot_entities(entity_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_statement_authorization_revisions (
    entity_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL,
    statement_id TEXT NOT NULL,
    restrictions_json TEXT NOT NULL CHECK (json_valid(restrictions_json)),
    effective_visibility_json TEXT NOT NULL CHECK (json_valid(effective_visibility_json)),
    authorization_revision INTEGER NOT NULL,
    PRIMARY KEY (entity_id, source_revision, statement_id),
    FOREIGN KEY (entity_id, source_revision)
      REFERENCES taproot_entity_revisions(entity_id, revision)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_authorization_projection_outbox (
    event_id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL,
    authorization_revision INTEGER NOT NULL,
    search_generation INTEGER NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'repair', 'backfill')),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'complete')),
    created_at TEXT NOT NULL,
    FOREIGN KEY (event_id) REFERENCES taproot_audit_events(event_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_authorization_backfill_plans (
    plan_id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    base_authorization_revision INTEGER NOT NULL,
    manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
    manifest_hash TEXT NOT NULL,
    entity_count INTEGER NOT NULL CHECK (entity_count > 0 AND entity_count <= 100),
    revision_count INTEGER NOT NULL CHECK (revision_count > 0),
    status TEXT NOT NULL CHECK (status IN ('planned', 'applying', 'complete')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_authorization_admin_audit (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL CHECK (event_type IN ('backfill-plan', 'backfill-apply')),
    principal_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    authorization_revision INTEGER NOT NULL,
    details_json TEXT NOT NULL CHECK (json_valid(details_json)),
    created_at TEXT NOT NULL,
    FOREIGN KEY (plan_id) REFERENCES taproot_authorization_backfill_plans(plan_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_installation_authorization_advances (
    advance_id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    from_revision INTEGER NOT NULL,
    to_revision INTEGER NOT NULL,
    search_generation INTEGER NOT NULL,
    domain TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (to_revision = from_revision + 1)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS taproot_entity_authorization_candidate_idx
    ON taproot_entity_authorization(installation_id, deleted_at, entity_id)`,
  `CREATE INDEX IF NOT EXISTS taproot_entity_authorization_revision_idx
    ON taproot_entity_authorization_revisions(entity_id, source_revision DESC)`,
  `CREATE INDEX IF NOT EXISTS taproot_statement_authorization_candidate_idx
    ON taproot_statement_authorization(entity_id, source_revision, statement_id)`,
  `CREATE INDEX IF NOT EXISTS taproot_authorization_outbox_state_idx
    ON taproot_authorization_projection_outbox(state, authorization_revision, event_id)`,
  `CREATE TRIGGER IF NOT EXISTS taproot_revisions_no_replace
    BEFORE INSERT ON taproot_entity_revisions
    WHEN EXISTS (
      SELECT 1 FROM taproot_entity_revisions
      WHERE entity_id = NEW.entity_id AND revision = NEW.revision
    )
    BEGIN SELECT RAISE(ABORT, 'taproot revisions cannot be replaced'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_audit_no_replace
    BEFORE INSERT ON taproot_audit_events
    WHEN EXISTS (
      SELECT 1 FROM taproot_audit_events WHERE event_id = NEW.event_id
    )
    BEGIN SELECT RAISE(ABORT, 'taproot audit events cannot be replaced'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_installation_identity_no_update
    BEFORE UPDATE OF installation_id ON taproot_installation_authorization
    BEGIN SELECT RAISE(ABORT, 'taproot installation identity is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_installation_authorization_no_delete
    BEFORE DELETE ON taproot_installation_authorization
    BEGIN SELECT RAISE(ABORT, 'taproot installation authorization is durable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_installation_authorization_no_replace
    BEFORE INSERT ON taproot_installation_authorization
    WHEN EXISTS (SELECT 1 FROM taproot_installation_authorization WHERE singleton = NEW.singleton)
    BEGIN SELECT RAISE(ABORT, 'taproot installation authorization cannot be replaced'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_entity_authorization_revisions_no_update
    BEFORE UPDATE ON taproot_entity_authorization_revisions
    BEGIN SELECT RAISE(ABORT, 'taproot authorization revisions are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_entity_authorization_revisions_no_delete
    BEFORE DELETE ON taproot_entity_authorization_revisions
    BEGIN SELECT RAISE(ABORT, 'taproot authorization revisions are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_entity_authorization_revisions_no_replace
    BEFORE INSERT ON taproot_entity_authorization_revisions
    WHEN EXISTS (
      SELECT 1 FROM taproot_entity_authorization_revisions
      WHERE (entity_id = NEW.entity_id AND source_revision = NEW.source_revision)
         OR event_id = NEW.event_id
    )
    BEGIN SELECT RAISE(ABORT, 'taproot authorization revisions cannot be replaced'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_statement_authorization_revisions_no_update
    BEFORE UPDATE ON taproot_statement_authorization_revisions
    BEGIN SELECT RAISE(ABORT, 'taproot statement authorization revisions are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_statement_authorization_revisions_no_delete
    BEFORE DELETE ON taproot_statement_authorization_revisions
    BEGIN SELECT RAISE(ABORT, 'taproot statement authorization revisions are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_statement_authorization_revisions_no_replace
    BEFORE INSERT ON taproot_statement_authorization_revisions
    WHEN EXISTS (
      SELECT 1 FROM taproot_statement_authorization_revisions
      WHERE entity_id = NEW.entity_id AND source_revision = NEW.source_revision
        AND statement_id = NEW.statement_id
    )
    BEGIN SELECT RAISE(ABORT, 'taproot statement authorization revisions cannot be replaced'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_authorization_admin_audit_no_update
    BEFORE UPDATE ON taproot_authorization_admin_audit
    BEGIN SELECT RAISE(ABORT, 'taproot authorization administration audit is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_authorization_admin_audit_no_delete
    BEFORE DELETE ON taproot_authorization_admin_audit
    BEGIN SELECT RAISE(ABORT, 'taproot authorization administration audit is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_authorization_admin_audit_no_replace
    BEFORE INSERT ON taproot_authorization_admin_audit
    WHEN EXISTS (
      SELECT 1 FROM taproot_authorization_admin_audit
      WHERE sequence = NEW.sequence OR audit_id = NEW.audit_id
    )
    BEGIN SELECT RAISE(ABORT, 'taproot authorization administration audit cannot be replaced'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_installation_authorization_advances_no_update
    BEFORE UPDATE ON taproot_installation_authorization_advances
    BEGIN SELECT RAISE(ABORT, 'taproot authorization advances are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_installation_authorization_advances_no_delete
    BEFORE DELETE ON taproot_installation_authorization_advances
    BEGIN SELECT RAISE(ABORT, 'taproot authorization advances are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_installation_authorization_advances_no_replace
    BEFORE INSERT ON taproot_installation_authorization_advances
    WHEN EXISTS (
      SELECT 1 FROM taproot_installation_authorization_advances
      WHERE advance_id = NEW.advance_id
    )
    BEGIN SELECT RAISE(ABORT, 'taproot authorization advances cannot be replaced'); END`,
  `INSERT INTO taproot_metadata(metadata_key, metadata_value)
    VALUES ('schema_version', '${PRE_SEARCH_SOURCE_SCHEMA_VERSION}')
    ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value`,
  `INSERT INTO taproot_migrations(version, name)
    VALUES (4, 'canonical-authorization-policy')
    ON CONFLICT(version) DO NOTHING`,
] as const;

/** Additive immutable unified-search source-event catalog introduced by migration 0005. */
export const taprootSearchSourceEventSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS taproot_unified_search_source_events (
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
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_unified_search_source_registry (
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
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS taproot_search_source_events_replay_idx
    ON taproot_unified_search_source_events(installation_id, source_kind, source_id, source_revision, payload_hash)`,
  `CREATE INDEX IF NOT EXISTS taproot_search_source_events_sequence_idx
    ON taproot_unified_search_source_events(installation_id, domain, source_kind, sequence)`,
  `CREATE INDEX IF NOT EXISTS taproot_search_source_registry_lookup_idx
    ON taproot_unified_search_source_registry(installation_id, domain, source_kind, source_id)`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_source_events_no_update
    BEFORE UPDATE ON taproot_unified_search_source_events
    BEGIN SELECT RAISE(ABORT, 'taproot unified-search source events are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_source_events_no_delete
    BEFORE DELETE ON taproot_unified_search_source_events
    BEGIN SELECT RAISE(ABORT, 'taproot unified-search source events are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_source_events_no_replace
    BEFORE INSERT ON taproot_unified_search_source_events
    WHEN EXISTS (
      SELECT 1 FROM taproot_unified_search_source_events
      WHERE event_id = NEW.event_id
         OR (installation_id = NEW.installation_id
             AND source_kind = NEW.source_kind
             AND source_id = NEW.source_id
             AND source_revision = NEW.source_revision)
    )
    BEGIN SELECT RAISE(ABORT, 'taproot unified-search source events cannot be replaced'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_source_events_predecessor_guard
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
    BEGIN SELECT RAISE(ABORT, 'taproot unified-search source predecessor is invalid'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_source_registry_event_insert_guard
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
    BEGIN SELECT RAISE(ABORT, 'taproot unified-search source registry event is invalid'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_source_registry_event_update_guard
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
    BEGIN SELECT RAISE(ABORT, 'taproot unified-search source registry event is invalid'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_source_registry_identity_no_update
    BEFORE UPDATE OF installation_id, source_kind, source_id, domain
    ON taproot_unified_search_source_registry
    BEGIN SELECT RAISE(ABORT, 'taproot unified-search source ownership is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_source_registry_no_delete
    BEFORE DELETE ON taproot_unified_search_source_registry
    BEGIN SELECT RAISE(ABORT, 'taproot unified-search source registry is durable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_source_registry_sequence_guard
    BEFORE UPDATE ON taproot_unified_search_source_registry
    WHEN NEW.current_event_sequence <= OLD.current_event_sequence
      OR NEW.search_generation <= OLD.search_generation
    BEGIN SELECT RAISE(ABORT, 'taproot unified-search source registry must advance'); END`,
  `INSERT INTO taproot_metadata(metadata_key, metadata_value)
    VALUES ('schema_version', '${PRE_EXTERNAL_SEARCH_PRODUCER_SCHEMA_VERSION}')
    ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value`,
  `INSERT INTO taproot_migrations(version, name)
    VALUES (5, 'unified-search-source-events')
    ON CONFLICT(version) DO NOTHING`,
] as const;

/** Dormant persisted unified-search materialization lifecycle (migration 0006). */
export const taprootSearchMaterializationSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS taproot_search_installation_state (
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
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_search_corpora (
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
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_search_kind_checkpoints (
    corpus_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('statement', 'item', 'task', 'memory', 'prompt', 'resource', 'annotation')),
    enqueued_sequence INTEGER NOT NULL DEFAULT 0 CHECK (enqueued_sequence >= 0),
    applied_sequence INTEGER NOT NULL DEFAULT 0 CHECK (applied_sequence >= 0),
    PRIMARY KEY (corpus_id, source_kind),
    FOREIGN KEY (corpus_id) REFERENCES taproot_search_corpora(corpus_id),
    CHECK (applied_sequence <= enqueued_sequence)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_search_projection_jobs (
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
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_search_job_transitions (
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
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_search_stages (
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
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_search_stage_pages (
    stage_id TEXT NOT NULL,
    page_ordinal INTEGER NOT NULL CHECK (page_ordinal >= 0),
    first_document_slot TEXT NOT NULL,
    last_document_slot TEXT NOT NULL,
    document_count INTEGER NOT NULL CHECK (document_count BETWEEN 1 AND 100),
    chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 0 AND 51200),
    page_hash TEXT NOT NULL,
    PRIMARY KEY (stage_id, page_ordinal),
    FOREIGN KEY (stage_id) REFERENCES taproot_search_stages(stage_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_search_staged_documents (
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
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_search_document_clauses (
    stage_id TEXT NOT NULL,
    document_slot TEXT NOT NULL,
    clause_ordinal INTEGER NOT NULL CHECK (clause_ordinal >= 0),
    PRIMARY KEY (stage_id, document_slot, clause_ordinal),
    FOREIGN KEY (stage_id, document_slot)
      REFERENCES taproot_search_staged_documents(stage_id, document_slot)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_search_document_atoms (
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
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_search_filter_values (
    stage_id TEXT NOT NULL,
    document_slot TEXT NOT NULL,
    filter_name TEXT NOT NULL CHECK (filter_name IN ('language', 'source_revision', 'predicate_id', 'type_id', 'status', 'media_type')),
    filter_value TEXT NOT NULL,
    PRIMARY KEY (stage_id, document_slot, filter_name, filter_value),
    FOREIGN KEY (stage_id, document_slot)
      REFERENCES taproot_search_staged_documents(stage_id, document_slot)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_search_chunks (
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
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_search_materialization_heads (
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
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_search_materialization_tombstones (
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
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_search_rebuild_roots (
    corpus_id TEXT NOT NULL,
    root_kind TEXT NOT NULL,
    root_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    source_event_sequence INTEGER NOT NULL,
    enumerated INTEGER NOT NULL DEFAULT 0 CHECK (enumerated IN (0, 1)),
    PRIMARY KEY (corpus_id, root_kind, root_id),
    FOREIGN KEY (corpus_id) REFERENCES taproot_search_corpora(corpus_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS taproot_search_admin_audit (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_id TEXT NOT NULL UNIQUE,
    installation_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('initialize', 'retry', 'rebuild-start', 'rebuild-ready', 'activate')),
    principal_id TEXT NOT NULL,
    corpus_id TEXT NOT NULL,
    details_json TEXT NOT NULL CHECK (json_valid(details_json)),
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS taproot_search_jobs_claim_pending_idx
    ON taproot_search_projection_jobs(installation_id, state, not_before, source_event_sequence, corpus_id)`,
  `CREATE INDEX IF NOT EXISTS taproot_search_jobs_claim_lease_idx
    ON taproot_search_projection_jobs(installation_id, state, lease_expires_at, source_event_sequence, corpus_id)`,
  `CREATE INDEX IF NOT EXISTS taproot_search_jobs_source_idx
    ON taproot_search_projection_jobs(installation_id, source_kind, source_id, source_event_sequence)`,
  `CREATE INDEX IF NOT EXISTS taproot_search_heads_root_idx
    ON taproot_search_materialization_heads(corpus_id, root_kind, root_id, source_event_sequence)`,
  `CREATE INDEX IF NOT EXISTS taproot_search_heads_eligibility_idx
    ON taproot_search_materialization_heads(corpus_id, eligible, root_kind, root_id)`,
  `CREATE INDEX IF NOT EXISTS taproot_search_chunks_document_idx
    ON taproot_search_chunks(stage_id, document_slot, ordinal)`,
  `CREATE INDEX IF NOT EXISTS taproot_search_filter_lookup_idx
    ON taproot_search_filter_values(filter_name, filter_value, stage_id, document_slot)`,
  `CREATE INDEX IF NOT EXISTS taproot_search_atoms_lookup_idx
    ON taproot_search_document_atoms(atom_kind, atom_value, stage_id, document_slot, clause_ordinal)`,
  `CREATE INDEX IF NOT EXISTS taproot_search_rebuild_enumeration_idx
    ON taproot_search_rebuild_roots(corpus_id, enumerated, root_kind, root_id)`,
  `CREATE INDEX IF NOT EXISTS taproot_search_source_events_root_idx
    ON taproot_unified_search_source_events(installation_id, source_kind, source_id, sequence)`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_jobs_source_guard
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
    BEGIN SELECT RAISE(ABORT, 'taproot search projection job source is invalid'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_transitions_no_update
    BEFORE UPDATE ON taproot_search_job_transitions
    BEGIN SELECT RAISE(ABORT, 'taproot search job transitions are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_transitions_no_delete
    BEFORE DELETE ON taproot_search_job_transitions
    BEGIN SELECT RAISE(ABORT, 'taproot search job transitions are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_tombstones_no_update
    BEFORE UPDATE ON taproot_search_materialization_tombstones
    BEGIN SELECT RAISE(ABORT, 'taproot search tombstones are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_tombstones_no_delete
    BEFORE DELETE ON taproot_search_materialization_tombstones
    BEGIN SELECT RAISE(ABORT, 'taproot search tombstones are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_admin_audit_no_update
    BEFORE UPDATE ON taproot_search_admin_audit
    BEGIN SELECT RAISE(ABORT, 'taproot search admin audit is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_admin_audit_no_delete
    BEFORE DELETE ON taproot_search_admin_audit
    BEGIN SELECT RAISE(ABORT, 'taproot search admin audit is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_heads_identity_guard
    BEFORE UPDATE OF corpus_id, root_kind, root_id
    ON taproot_search_materialization_heads
    BEGIN SELECT RAISE(ABORT, 'taproot search document identity is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_heads_sequence_guard
    BEFORE UPDATE OF source_event_sequence ON taproot_search_materialization_heads
    WHEN NEW.source_event_sequence <= OLD.source_event_sequence
    BEGIN SELECT RAISE(ABORT, 'taproot search materialization head must advance'); END`,
  `CREATE TRIGGER IF NOT EXISTS taproot_search_committed_stage_no_update
    BEFORE UPDATE ON taproot_search_stages
    WHEN OLD.state = 'committed'
    BEGIN SELECT RAISE(ABORT, 'taproot committed search stages are immutable'); END`,
  `INSERT INTO taproot_metadata(metadata_key, metadata_value)
    VALUES ('schema_version', '${PRE_EXTERNAL_SEARCH_PRODUCER_SCHEMA_VERSION}')
    ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value`,
  `INSERT INTO taproot_migrations(version, name)
    VALUES (6, 'unified-search-materialization-lifecycle')
    ON CONFLICT(version) DO NOTHING`,
] as const;

/** Durable host-sealed producer catalog and seven-kind lifecycle (migration 0007). */
export const taprootExternalSearchProducerSchemaStatements = [
  `DROP TRIGGER IF EXISTS taproot_search_source_events_no_update`,
  `DROP TRIGGER IF EXISTS taproot_search_source_registry_event_insert_guard`,
  `DROP TRIGGER IF EXISTS taproot_search_source_registry_event_update_guard`,
  `DROP TRIGGER IF EXISTS taproot_search_source_registry_sequence_guard`,
  `DROP TRIGGER IF EXISTS taproot_search_committed_stage_no_update`,
  `DROP TRIGGER IF EXISTS taproot_search_jobs_source_guard`,
  `ALTER TABLE taproot_unified_search_source_events
     ADD COLUMN source_policy_revision INTEGER NOT NULL DEFAULT 1
       CHECK (source_policy_revision >= 1)`,
  `UPDATE taproot_unified_search_source_events
     SET source_policy_revision = authorization_revision`,
  `ALTER TABLE taproot_unified_search_source_registry
     ADD COLUMN source_policy_revision INTEGER NOT NULL DEFAULT 1
       CHECK (source_policy_revision >= 1)`,
  `UPDATE taproot_unified_search_source_registry
     SET source_policy_revision = authorization_revision`,
  `ALTER TABLE taproot_search_projection_jobs
     ADD COLUMN source_policy_revision INTEGER NOT NULL DEFAULT 1
       CHECK (source_policy_revision >= 1)`,
  `ALTER TABLE taproot_search_projection_jobs
     ADD COLUMN producer_fingerprint TEXT`,
  `UPDATE taproot_search_projection_jobs
     SET source_policy_revision = authorization_revision,
         producer_fingerprint = CASE
           WHEN source_kind IN ('statement', 'item')
             THEN 'taproot-builtin-projection-v1'
           ELSE NULL END`,
  `ALTER TABLE taproot_search_stages
     ADD COLUMN source_policy_revision INTEGER NOT NULL DEFAULT 1
       CHECK (source_policy_revision >= 1)`,
  `ALTER TABLE taproot_search_stages
     ADD COLUMN producer_fingerprint TEXT`,
  `UPDATE taproot_search_stages
     SET source_policy_revision = authorization_revision,
         producer_fingerprint = CASE
           WHEN root_kind IN ('statement', 'item')
             THEN 'taproot-builtin-projection-v1'
           ELSE NULL END`,
  `ALTER TABLE taproot_search_materialization_heads
     ADD COLUMN source_policy_revision INTEGER NOT NULL DEFAULT 1
       CHECK (source_policy_revision >= 1)`,
  `ALTER TABLE taproot_search_materialization_heads
     ADD COLUMN producer_fingerprint TEXT`,
  `UPDATE taproot_search_materialization_heads
     SET source_policy_revision = authorization_revision,
         producer_fingerprint = CASE
           WHEN root_kind IN ('statement', 'item')
             THEN 'taproot-builtin-projection-v1'
           ELSE NULL END`,
  `ALTER TABLE taproot_search_installation_state
     RENAME TO taproot_search_installation_state_0006`,
  `CREATE TABLE taproot_search_installation_state (
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
  ) STRICT`,
  `INSERT INTO taproot_search_installation_state
     SELECT * FROM taproot_search_installation_state_0006`,
  `DROP TABLE taproot_search_installation_state_0006`,
  `DROP INDEX IF EXISTS taproot_search_chunks_document_idx`,
  `DROP INDEX IF EXISTS taproot_search_filter_lookup_idx`,
  `DROP INDEX IF EXISTS taproot_search_atoms_lookup_idx`,
  `ALTER TABLE taproot_search_staged_documents
     RENAME TO taproot_search_staged_documents_0006`,
  `ALTER TABLE taproot_search_document_clauses
     RENAME TO taproot_search_document_clauses_0006`,
  `ALTER TABLE taproot_search_document_atoms
     RENAME TO taproot_search_document_atoms_0006`,
  `ALTER TABLE taproot_search_filter_values
     RENAME TO taproot_search_filter_values_0006`,
  `ALTER TABLE taproot_search_chunks
     RENAME TO taproot_search_chunks_0006`,
  `CREATE TABLE taproot_search_staged_documents (
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
  ) STRICT`,
  `CREATE TABLE taproot_search_document_clauses (
    stage_id TEXT NOT NULL,
    document_slot TEXT NOT NULL,
    clause_ordinal INTEGER NOT NULL CHECK (clause_ordinal >= 0),
    PRIMARY KEY (stage_id, document_slot, clause_ordinal),
    FOREIGN KEY (stage_id, document_slot)
      REFERENCES taproot_search_staged_documents(stage_id, document_slot)
  ) STRICT`,
  `CREATE TABLE taproot_search_document_atoms (
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
  ) STRICT`,
  `CREATE TABLE taproot_search_filter_values (
    stage_id TEXT NOT NULL,
    document_slot TEXT NOT NULL,
    filter_name TEXT NOT NULL CHECK (filter_name IN ('language', 'source_revision', 'predicate_id', 'type_id', 'status', 'media_type')),
    filter_value TEXT NOT NULL,
    PRIMARY KEY (stage_id, document_slot, filter_name, filter_value),
    FOREIGN KEY (stage_id, document_slot)
      REFERENCES taproot_search_staged_documents(stage_id, document_slot)
  ) STRICT`,
  `CREATE TABLE taproot_search_chunks (
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
  ) STRICT`,
  `INSERT INTO taproot_search_staged_documents
     SELECT * FROM taproot_search_staged_documents_0006`,
  `INSERT INTO taproot_search_document_clauses
     SELECT * FROM taproot_search_document_clauses_0006`,
  `INSERT INTO taproot_search_document_atoms
     SELECT * FROM taproot_search_document_atoms_0006`,
  `INSERT INTO taproot_search_filter_values
     SELECT * FROM taproot_search_filter_values_0006`,
  `INSERT INTO taproot_search_chunks
     SELECT * FROM taproot_search_chunks_0006`,
  `DROP TABLE taproot_search_document_atoms_0006`,
  `DROP TABLE taproot_search_document_clauses_0006`,
  `DROP TABLE taproot_search_filter_values_0006`,
  `DROP TABLE taproot_search_chunks_0006`,
  `DROP TABLE taproot_search_staged_documents_0006`,
  `CREATE INDEX taproot_search_chunks_document_idx
    ON taproot_search_chunks(stage_id, document_slot, ordinal)`,
  `CREATE INDEX taproot_search_filter_lookup_idx
    ON taproot_search_filter_values(filter_name, filter_value, stage_id, document_slot)`,
  `CREATE INDEX taproot_search_atoms_lookup_idx
    ON taproot_search_document_atoms(atom_kind, atom_value, stage_id, document_slot, clause_ordinal)`,
  `CREATE TABLE taproot_unified_search_producer_manifests (
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
  ) STRICT`,
  `CREATE TABLE taproot_unified_search_producer_adoptions (
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
  ) STRICT`,
  `CREATE TABLE taproot_unified_search_generation_producers (
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
  ) STRICT`,
  `CREATE TABLE taproot_unified_search_producer_admin_audit (
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
  ) STRICT`,
  `CREATE INDEX taproot_search_producer_adoption_state_idx
    ON taproot_unified_search_producer_adoptions(installation_id, state, source_kind)`,
  `CREATE INDEX taproot_search_generation_producer_state_idx
    ON taproot_unified_search_generation_producers(installation_id, state, source_kind, corpus_id)`,
  `CREATE TRIGGER taproot_search_producer_manifests_no_update
    BEFORE UPDATE ON taproot_unified_search_producer_manifests
    BEGIN SELECT RAISE(ABORT, 'taproot search producer manifests are immutable'); END`,
  `CREATE TRIGGER taproot_search_producer_manifests_no_delete
    BEFORE DELETE ON taproot_unified_search_producer_manifests
    BEGIN SELECT RAISE(ABORT, 'taproot search producer manifests are durable'); END`,
  `CREATE TRIGGER taproot_search_producer_audit_no_update
    BEFORE UPDATE ON taproot_unified_search_producer_admin_audit
    BEGIN SELECT RAISE(ABORT, 'taproot search producer audit is immutable'); END`,
  `CREATE TRIGGER taproot_search_producer_audit_no_delete
    BEFORE DELETE ON taproot_unified_search_producer_admin_audit
    BEGIN SELECT RAISE(ABORT, 'taproot search producer audit is immutable'); END`,
  `INSERT INTO taproot_unified_search_producer_manifests(
     installation_id, source_kind, producer_fingerprint, owning_domain,
     contract_version, projection_version, authorization_contract_version,
     manifest_revision, created_at)
   SELECT installation_id, kind, 'taproot-builtin-projection-v1', 'taproot',
          'taproot-external-search-producer-v1',
          'taproot-unified-search-projection-v1',
          'taproot-search-authorization-v1', 1, updated_at
   FROM taproot_installation_authorization
   CROSS JOIN (SELECT 'statement' AS kind UNION ALL SELECT 'item')`,
  ...(
    [
      'statement',
      'item',
      'task',
      'memory',
      'prompt',
      'resource',
      'annotation',
    ] as const
  ).map(
    (kind) => `INSERT INTO taproot_unified_search_producer_adoptions(
       installation_id, source_kind, producer_fingerprint, state,
       manifest_revision, updated_at)
     SELECT installation_id, '${kind}',
       ${kind === 'statement' || kind === 'item' ? "'taproot-builtin-projection-v1', 'ready'" : "NULL, 'blocked'"},
       1, updated_at FROM taproot_installation_authorization`,
  ),
  ...(
    [
      'statement',
      'item',
      'task',
      'memory',
      'prompt',
      'resource',
      'annotation',
    ] as const
  ).map(
    (kind) => `INSERT INTO taproot_unified_search_generation_producers(
       corpus_id, installation_id, source_kind, producer_fingerprint,
       contract_version, projection_version, authorization_contract_version,
       state, updated_at)
     SELECT corpus_id, installation_id, '${kind}',
       ${kind === 'statement' || kind === 'item' ? "'taproot-builtin-projection-v1', 'taproot-external-search-producer-v1', 'taproot-unified-search-projection-v1', 'taproot-search-authorization-v1', 'ready'" : "NULL, NULL, NULL, NULL, 'blocked'"},
       created_at FROM taproot_search_corpora`,
  ),
  `CREATE TRIGGER taproot_search_source_events_no_update
    BEFORE UPDATE ON taproot_unified_search_source_events
    BEGIN SELECT RAISE(ABORT, 'taproot unified-search source events are immutable'); END`,
  `CREATE TRIGGER taproot_search_source_registry_event_update_guard
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
    BEGIN SELECT RAISE(ABORT, 'taproot unified-search source registry event is invalid'); END`,
  `CREATE TRIGGER taproot_search_source_registry_event_insert_guard
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
    BEGIN SELECT RAISE(ABORT, 'taproot unified-search source registry event is invalid'); END`,
  `CREATE TRIGGER taproot_search_source_registry_sequence_guard
    BEFORE UPDATE ON taproot_unified_search_source_registry
    WHEN NEW.current_event_sequence <= OLD.current_event_sequence
      OR NEW.search_generation <= OLD.search_generation
    BEGIN SELECT RAISE(ABORT, 'taproot unified-search source registry must advance'); END`,
  `CREATE TRIGGER taproot_search_committed_stage_no_update
    BEFORE UPDATE ON taproot_search_stages
    WHEN OLD.state = 'committed'
    BEGIN SELECT RAISE(ABORT, 'taproot committed search stages are immutable'); END`,
  `CREATE TRIGGER taproot_search_jobs_source_guard
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
    BEGIN SELECT RAISE(ABORT, 'taproot search projection job source is invalid'); END`,
  `INSERT INTO taproot_metadata(metadata_key, metadata_value)
    VALUES ('schema_version', '${TAPROOT_SCHEMA_VERSION}')
    ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value`,
  `INSERT INTO taproot_migrations(version, name)
    VALUES (7, 'external-search-producers')
    ON CONFLICT(version) DO NOTHING`,
] as const;

/** Exact package catalog immediately before migration 0005. */
export const preSearchSourceEventTaprootSchemaStatements = [
  ...preAuthorizationTaprootSchemaStatements,
  ...taprootAuthorizationSchemaStatements,
] as const;

/** Exact package catalog immediately before migration 0006. */
export const preSearchMaterializationTaprootSchemaStatements = [
  ...preSearchSourceEventTaprootSchemaStatements,
  ...taprootSearchSourceEventSchemaStatements.map((sql) =>
    sql.replace(
      `VALUES ('schema_version', '${PRE_EXTERNAL_SEARCH_PRODUCER_SCHEMA_VERSION}')`,
      `VALUES ('schema_version', '${PRE_SEARCH_MATERIALIZATION_SCHEMA_VERSION}')`,
    ),
  ),
] as const;

/** Exact package catalog immediately before migration 0007. */
export const preExternalSearchProducerTaprootSchemaStatements = [
  ...preSearchMaterializationTaprootSchemaStatements,
  ...taprootSearchMaterializationSchemaStatements,
] as const;

const externalProducerReplacedCatalogObjects = new Set([
  'taproot_unified_search_source_events',
  'taproot_unified_search_source_registry',
  'taproot_search_installation_state',
  'taproot_search_projection_jobs',
  'taproot_search_stages',
  'taproot_search_staged_documents',
  'taproot_search_document_clauses',
  'taproot_search_document_atoms',
  'taproot_search_filter_values',
  'taproot_search_chunks',
  'taproot_search_materialization_heads',
  'taproot_search_chunks_document_idx',
  'taproot_search_filter_lookup_idx',
  'taproot_search_atoms_lookup_idx',
  'taproot_search_source_events_no_update',
  'taproot_search_source_registry_event_insert_guard',
  'taproot_search_source_registry_event_update_guard',
  'taproot_search_source_registry_sequence_guard',
  'taproot_search_committed_stage_no_update',
  'taproot_search_jobs_source_guard',
]);

const catalogSql = (statements: readonly string[], prefix: string): string => {
  const value = statements.find((sql) => sql.trimStart().startsWith(prefix));
  if (!value) throw new Error(`Missing final catalog statement: ${prefix}`);
  return value;
};

const appendColumns = (sql: string, columns: string): string => {
  const constraint =
    /\n {4}(?=(?:CHECK|PRIMARY KEY|UNIQUE|FOREIGN KEY)\b)/u.exec(sql);
  if (constraint)
    return `${sql.slice(0, constraint.index)}\n${columns},${sql.slice(constraint.index)}`;
  return sql.replace(/\n {2}\) STRICT$/u, `,\n${columns}\n  ) STRICT`);
};

const finalExternalProducerAlteredCatalogStatements = [
  appendColumns(
    catalogSql(
      preExternalSearchProducerTaprootSchemaStatements,
      'CREATE TABLE IF NOT EXISTS taproot_unified_search_source_events',
    ),
    `    source_policy_revision INTEGER NOT NULL DEFAULT 1
      CHECK (source_policy_revision >= 1)`,
  ),
  appendColumns(
    catalogSql(
      preExternalSearchProducerTaprootSchemaStatements,
      'CREATE TABLE IF NOT EXISTS taproot_unified_search_source_registry',
    ),
    `    source_policy_revision INTEGER NOT NULL DEFAULT 1
      CHECK (source_policy_revision >= 1)`,
  ),
  appendColumns(
    catalogSql(
      preExternalSearchProducerTaprootSchemaStatements,
      'CREATE TABLE IF NOT EXISTS taproot_search_projection_jobs',
    ),
    `    source_policy_revision INTEGER NOT NULL DEFAULT 1
      CHECK (source_policy_revision >= 1),
    producer_fingerprint TEXT`,
  ),
  appendColumns(
    catalogSql(
      preExternalSearchProducerTaprootSchemaStatements,
      'CREATE TABLE IF NOT EXISTS taproot_search_stages',
    ),
    `    source_policy_revision INTEGER NOT NULL DEFAULT 1
      CHECK (source_policy_revision >= 1),
    producer_fingerprint TEXT`,
  ),
  appendColumns(
    catalogSql(
      preExternalSearchProducerTaprootSchemaStatements,
      'CREATE TABLE IF NOT EXISTS taproot_search_materialization_heads',
    ),
    `    source_policy_revision INTEGER NOT NULL DEFAULT 1
      CHECK (source_policy_revision >= 1),
    producer_fingerprint TEXT`,
  ),
] as const;

const finalExternalProducerCreatedCatalogStatements =
  taprootExternalSearchProducerSchemaStatements.filter((sql) => {
    const match =
      /^\s*CREATE\s+(?:TABLE|INDEX|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)/iu.exec(
        sql,
      );
    return match !== null && !match[1]!.endsWith('_0006');
  });

const taprootCurrentCatalogStatements = [
  ...preExternalSearchProducerTaprootSchemaStatements.filter((sql) => {
    const match =
      /^\s*CREATE\s+(?:TABLE|INDEX|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)/iu.exec(
        sql,
      );
    return !match || !externalProducerReplacedCatalogObjects.has(match[1]!);
  }),
  ...finalExternalProducerAlteredCatalogStatements,
  ...finalExternalProducerCreatedCatalogStatements,
  `INSERT INTO taproot_metadata(metadata_key, metadata_value)
    VALUES ('schema_version', '${TAPROOT_SCHEMA_VERSION}')
    ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value`,
  `INSERT INTO taproot_migrations(version, name)
    VALUES (7, 'external-search-producers')
    ON CONFLICT(version) DO NOTHING`,
] as const;

/** Ordered executable schema used for fresh initialization and recovery. */
export const taprootSchemaStatements = [
  ...preExternalSearchProducerTaprootSchemaStatements,
  ...taprootExternalSearchProducerSchemaStatements,
] as const;

/** Exact package-created schema before authored statement text became required. */
export const preStatementTextTaprootSchemaStatements =
  preAuthorizationTaprootSchemaStatements.map((sql) =>
    sql
      .replace(
        "('canonical_json_version', '2')",
        "('canonical_json_version', '1')",
      )
      .replace(", (3, 'canonical-statement-text')", ''),
  );

const schemaStatement = (prefix: string): string => {
  const statement = preAuthorizationTaprootSchemaStatements.find((sql) =>
    sql.trimStart().startsWith(prefix),
  );
  if (!statement)
    throw new Error(`Missing Taproot schema statement: ${prefix}`);
  return statement;
};

/** Exact package-created schema used before the v2 audit migration. */
export const legacyTaprootV1Statements = [
  schemaStatement('CREATE TABLE IF NOT EXISTS taproot_entities'),
  `CREATE TABLE IF NOT EXISTS taproot_entity_revisions (
    entity_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    entity_json TEXT NOT NULL CHECK (json_valid(entity_json)),
    actor TEXT,
    edit_summary TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (entity_id, revision),
    FOREIGN KEY (entity_id) REFERENCES taproot_entities(entity_id)
  ) STRICT`,
  schemaStatement('CREATE TABLE IF NOT EXISTS taproot_id_counters'),
  schemaStatement('CREATE TABLE IF NOT EXISTS taproot_terms'),
  schemaStatement('CREATE TABLE IF NOT EXISTS taproot_metadata'),
  schemaStatement('CREATE TABLE IF NOT EXISTS taproot_assertions'),
  schemaStatement('CREATE INDEX IF NOT EXISTS taproot_entities_type_idx'),
  schemaStatement('CREATE INDEX IF NOT EXISTS taproot_entities_modified_idx'),
  schemaStatement('CREATE INDEX IF NOT EXISTS taproot_revisions_entity_idx'),
  schemaStatement('CREATE INDEX IF NOT EXISTS taproot_terms_lookup_idx'),
  `INSERT INTO taproot_id_counters(entity_type, next_numeric_id)
   VALUES ('item', 1), ('property', 1)`,
  `INSERT INTO taproot_metadata(metadata_key, metadata_value)
   VALUES
     ('schema_version', '1'),
     ('canonical_json_version', '1'),
     ('rdf_mapping_version', '1')`,
] as const;

const currentRevisionStatement = schemaStatement(
  'CREATE TABLE IF NOT EXISTS taproot_entity_revisions',
);
const transitionalRevisionStatement = currentRevisionStatement
  .replace('event_id TEXT NOT NULL', 'event_id TEXT')
  .replace('content_hash TEXT NOT NULL', 'content_hash TEXT');

export const taprootUpgradeCatalogStatements =
  preAuthorizationTaprootSchemaStatements
    .filter(
      (sql) =>
        /^\s*CREATE\s+(?:TABLE|INDEX)\s+/iu.test(sql) &&
        !/^\s*CREATE\s+TRIGGER\s+/iu.test(sql) &&
        !sql.includes('taproot_audit'),
    )
    .map((sql) =>
      sql === currentRevisionStatement ? transitionalRevisionStatement : sql,
    );

export const taprootPreFinalizeCatalogStatements =
  preAuthorizationTaprootSchemaStatements.filter(
    (sql) =>
      /^\s*CREATE\s+(?:TABLE|INDEX)\s+/iu.test(sql) &&
      !/^\s*CREATE\s+TRIGGER\s+/iu.test(sql),
  );

export const legacyTaprootStructureStatements = [
  `ALTER TABLE taproot_entity_revisions RENAME TO taproot_entity_revisions_v1`,
  transitionalRevisionStatement,
  `INSERT INTO taproot_entity_revisions(
     entity_id, revision, entity_json, actor, attribution_json, edit_summary,
     tags_json, event_id, content_hash, parent_hash, deleted_at, redirect_to, created_at
   )
   SELECT entity_id, revision, entity_json, actor, NULL, edit_summary,
     '[]', NULL, NULL, NULL, NULL, NULL, created_at
   FROM taproot_entity_revisions_v1`,
  `DROP TABLE taproot_entity_revisions_v1`,
  ...taprootUpgradeCatalogStatements.filter(
    (sql) => !sql.includes('taproot_entity_revisions ('),
  ),
] as const;

export const legacyRevisionFinalizeStatements = [
  `ALTER TABLE taproot_entity_revisions RENAME TO taproot_entity_revisions_backfill`,
  currentRevisionStatement,
  `INSERT INTO taproot_entity_revisions(
     entity_id, revision, entity_json, actor, attribution_json, edit_summary,
     tags_json, event_id, content_hash, parent_hash, deleted_at, redirect_to, created_at
   ) SELECT entity_id, revision, entity_json, actor, attribution_json, edit_summary,
     tags_json, event_id, content_hash, parent_hash, deleted_at, redirect_to, created_at
   FROM taproot_entity_revisions_backfill`,
  `DROP TABLE taproot_entity_revisions_backfill`,
  schemaStatement('CREATE TABLE IF NOT EXISTS taproot_audit_events'),
  schemaStatement('CREATE INDEX IF NOT EXISTS taproot_revisions_entity_idx'),
  schemaStatement('CREATE INDEX IF NOT EXISTS taproot_audit_entity_idx'),
  schemaStatement('CREATE INDEX IF NOT EXISTS taproot_audit_request_idx'),
] as const;

export const taprootFinalizeStatements = [
  ...preAuthorizationTaprootSchemaStatements.filter(
    (sql) =>
      /^\s*CREATE\s+TRIGGER\s+/iu.test(sql) ||
      sql.includes(
        `('schema_version', '${PRE_AUTHORIZATION_SCHEMA_VERSION}')`,
      ) ||
      sql.includes('INSERT INTO taproot_migrations'),
  ),
  ...taprootAuthorizationSchemaStatements,
  ...taprootSearchSourceEventSchemaStatements,
  ...taprootSearchMaterializationSchemaStatements,
] as const;

export interface TaprootSchemaInspection {
  valid: boolean;
  versions: Record<string, string>;
  missingTables: string[];
  nonStrictTables: string[];
  missingColumns: string[];
  missingIndexes: string[];
  missingTriggers: string[];
  errors: string[];
}

export async function initializeTaproot(
  db: SqliteDatabaseLike,
  options: { baseIri?: string } = {},
): Promise<void> {
  const { applyTaprootMigrations } = await import('./migrations.js');
  await applyTaprootMigrations(db, options);
}

export async function isRecognizedLegacyV1(
  db: SqliteDatabaseLike,
  tables: Array<{ name: string }>,
): Promise<boolean> {
  const expectedTables = [
    'taproot_assertions',
    'taproot_entities',
    'taproot_entity_revisions',
    'taproot_id_counters',
    'taproot_metadata',
    'taproot_terms',
  ];
  if (
    JSON.stringify(tables.map(({ name }) => name)) !==
    JSON.stringify(expectedTables)
  )
    return false;
  if (!(await matchesExactCatalog(db, legacyTaprootV1Statements))) return false;
  const metadata = await db
    .prepare(
      `SELECT metadata_key, metadata_value FROM taproot_metadata
       WHERE metadata_key IN ('schema_version', 'canonical_json_version', 'rdf_mapping_version')
       ORDER BY metadata_key`,
    )
    .all<{ metadata_key: string; metadata_value: string }>();
  return (
    JSON.stringify(metadata.results) ===
    JSON.stringify([
      { metadata_key: 'canonical_json_version', metadata_value: '1' },
      { metadata_key: 'rdf_mapping_version', metadata_value: '1' },
      { metadata_key: 'schema_version', metadata_value: '1' },
    ])
  );
}

async function readMetadata(
  db: SqliteDatabaseLike,
  key: string,
): Promise<string | undefined> {
  const table = await db
    .prepare(
      `SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'taproot_metadata'`,
    )
    .all<{ found: number }>();
  if (!table.results.length) return undefined;
  const result = await db
    .prepare(
      `SELECT metadata_value FROM taproot_metadata WHERE metadata_key = ?`,
    )
    .bind(key)
    .all<{ metadata_value: string }>();
  return result.results[0]?.metadata_value;
}

export async function backfillRdfOwnership(
  db: SqliteDatabaseLike,
  previousVersion: string | undefined,
  previousBaseIri?: string,
): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT entity_id, entity_json, deleted_at, redirect_to FROM taproot_entities ORDER BY entity_id`,
    )
    .all<{
      entity_id: EntityId;
      entity_json: string;
      deleted_at: string | null;
      redirect_to: EntityId | null;
    }>();
  if (!rows.results.length) return;
  const baseIri = await readMetadata(db, 'base_iri');
  if (!baseIri)
    throw new SchemaMismatchError(
      'Taproot RDF ownership cannot be rebuilt without a database identity',
    );
  const factory = new DataFactory();
  for (const row of rows.results) {
    const entity = parseEntityJson(row.entity_json);
    const current = lifecycleQuads(
      entity,
      row.deleted_at,
      row.redirect_to,
      baseIri,
      TAPROOT_RDF_VERSION,
      factory,
    );
    const old =
      previousVersion &&
      (previousVersion !== TAPROOT_RDF_VERSION || previousBaseIri !== baseIri)
        ? lifecycleQuads(
            entity,
            row.deleted_at,
            row.redirect_to,
            previousBaseIri ?? baseIri,
            previousVersion,
            factory,
          )
        : [];
    const patch = prepareQuadPatch(db, { delete: old, insert: current });
    const ownershipRows = current.map((quad) => ({
      subjectKey: encodeTerm(quad.subject).key,
      predicateKey: encodeTerm(quad.predicate).key,
      objectKey: encodeTerm(quad.object).key,
      graphKey: encodeTerm(quad.graph).key,
    }));
    await db.batch([
      ...patch.statements,
      db
        .prepare(`DELETE FROM taproot_rdf_ownership WHERE entity_id = ?`)
        .bind(row.entity_id),
      db
        .prepare(
          `INSERT INTO taproot_rdf_ownership(entity_id, subject_key, predicate_key, object_key, graph_key)
         SELECT ?, json_extract(value, '$.subjectKey'), json_extract(value, '$.predicateKey'),
           json_extract(value, '$.objectKey'), json_extract(value, '$.graphKey') FROM json_each(?)`,
        )
        .bind(row.entity_id, JSON.stringify(ownershipRows)),
    ]);
  }
}

function lifecycleQuads(
  entity: WikibaseEntity,
  deletedAt: string | null,
  redirectTo: EntityId | null,
  baseIri: string,
  mappingVersion: string,
  factory: DataFactory,
) {
  if (!deletedAt && !redirectTo)
    return buildEntityQuads(entity, { baseIri, mappingVersion, factory });
  let end = baseIri.length;
  while (end > 0 && baseIri.charCodeAt(end - 1) === 47) end -= 1;
  const base = baseIri.slice(0, end);
  const subject = factory.namedNode(`${base}/entity/${entity.id}`);
  const quads = [
    factory.quad(
      subject,
      factory.namedNode(`${base}/vocab/revision`),
      factory.literal(
        String(entity.lastrevid),
        factory.namedNode('http://www.w3.org/2001/XMLSchema#integer'),
      ),
    ),
  ];
  if (deletedAt)
    quads.push(
      factory.quad(
        subject,
        factory.namedNode(`${base}/vocab/deletedAt`),
        factory.literal(
          deletedAt,
          factory.namedNode('http://www.w3.org/2001/XMLSchema#dateTime'),
        ),
      ),
    );
  if (redirectTo)
    quads.push(
      factory.quad(
        subject,
        factory.namedNode('http://www.w3.org/2002/07/owl#sameAs'),
        factory.namedNode(`${base}/entity/${redirectTo}`),
      ),
    );
  return quads;
}

export async function backfillLegacyRevisions(
  db: SqliteDatabaseLike,
): Promise<void> {
  const revisions = await db
    .prepare(
      `SELECT r.entity_id, r.revision, r.entity_json, r.actor, r.event_id, r.content_hash,
       CASE WHEN r.revision = e.revision THEN e.deleted_at ELSE r.deleted_at END AS deleted_at,
       CASE WHEN r.revision = e.revision THEN e.redirect_to ELSE r.redirect_to END AS redirect_to
     FROM taproot_entity_revisions r JOIN taproot_entities e ON e.entity_id = r.entity_id
     ORDER BY r.entity_id, r.revision`,
    )
    .all<{
      entity_id: string;
      revision: number;
      entity_json: string;
      actor: string | null;
      event_id: string | null;
      content_hash: string | null;
      deleted_at: string | null;
      redirect_to: string | null;
    }>();
  let previousEntity = '';
  let parentHash: string | null = null;
  for (const revision of revisions.results) {
    if (revision.entity_id !== previousEntity) parentHash = null;
    const contentHash = await hash(
      `${revision.entity_json}\n${JSON.stringify({ deletedAt: revision.deleted_at, redirectTo: revision.redirect_to })}`,
    );
    const eventId = `legacy-${revision.entity_id}-${revision.revision}`;
    if (
      (revision.event_id !== null && revision.event_id !== eventId) ||
      (revision.content_hash !== null && revision.content_hash !== contentHash)
    ) {
      throw new SchemaMismatchError(
        `Legacy revision ${revision.entity_id}@${revision.revision} has conflicting durable identity`,
      );
    }
    if (!revision.event_id || !revision.content_hash) {
      const attribution = revision.actor
        ? JSON.stringify({ id: revision.actor, kind: 'human' })
        : null;
      await db.batch([
        db
          .prepare(
            `UPDATE taproot_entity_revisions SET event_id = ?, content_hash = ?,
          parent_hash = ?, attribution_json = COALESCE(attribution_json, ?),
          tags_json = COALESCE(tags_json, '[]'), deleted_at = ?, redirect_to = ?
          WHERE entity_id = ? AND revision = ?`,
          )
          .bind(
            eventId,
            contentHash,
            parentHash,
            attribution,
            revision.deleted_at,
            revision.redirect_to,
            revision.entity_id,
            revision.revision,
          ),
      ]);
    } else {
      const storedParent = await db
        .prepare(
          `SELECT parent_hash FROM taproot_entity_revisions
           WHERE entity_id = ? AND revision = ?`,
        )
        .bind(revision.entity_id, revision.revision)
        .all<{ parent_hash: string | null }>();
      if (storedParent.results[0]?.parent_hash !== parentHash)
        throw new SchemaMismatchError(
          `Legacy revision ${revision.entity_id}@${revision.revision} has a conflicting parent hash`,
        );
    }
    previousEntity = revision.entity_id;
    parentHash = contentHash;
  }
}

export async function backfillTaprootAudit(
  db: SqliteDatabaseLike,
): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT INTO taproot_audit_events(
         event_id, entity_id, revision, event_type, attribution_json,
         edit_summary, tags_json, content_hash, parent_hash, details_json, created_at
       )
       SELECT event_id, entity_id, revision, 'import',
         attribution_json, edit_summary, tags_json, content_hash, parent_hash,
         json_object('source', 'legacy-v1'), created_at
       FROM taproot_entity_revisions revision
       WHERE NOT EXISTS (
         SELECT 1 FROM taproot_audit_events audit
         WHERE audit.event_id = revision.event_id
       )`,
    ),
  ]);
}

export async function verifyTaprootSemanticState(
  db: SqliteDatabaseLike,
  baseIri: string,
): Promise<void> {
  const incomplete = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM taproot_entity_revisions r
       LEFT JOIN taproot_audit_events a ON a.event_id = r.event_id
       WHERE r.event_id IS NULL OR r.content_hash IS NULL OR a.event_id IS NULL
         OR a.entity_id IS NOT r.entity_id OR a.revision IS NOT r.revision
         OR a.content_hash IS NOT r.content_hash
         OR a.parent_hash IS NOT r.parent_hash
         OR a.attribution_json IS NOT r.attribution_json
         OR a.edit_summary IS NOT r.edit_summary
         OR a.tags_json IS NOT r.tags_json
         OR a.created_at IS NOT r.created_at`,
    )
    .all<{ count: number }>();
  if (Number(incomplete.results[0]?.count ?? 0) !== 0)
    throw new SchemaMismatchError(
      'Taproot revision identity or audit backfill is incomplete',
    );
  const dangling = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM taproot_rdf_ownership o
       LEFT JOIN taproot_entities e ON e.entity_id = o.entity_id
       WHERE e.entity_id IS NULL`,
    )
    .all<{ count: number }>();
  if (Number(dangling.results[0]?.count ?? 0) !== 0)
    throw new SchemaMismatchError(
      'Taproot RDF ownership contains dangling rows',
    );
  const missingProjection = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM taproot_rdf_ownership o
       LEFT JOIN rdf_quads q
         ON q.subject_key = o.subject_key
        AND q.predicate_key = o.predicate_key
        AND q.object_key = o.object_key
        AND q.graph_key = o.graph_key
       WHERE q.id IS NULL`,
    )
    .all<{ count: number }>();
  if (Number(missingProjection.results[0]?.count ?? 0) !== 0)
    throw new SchemaMismatchError(
      'Taproot RDF ownership is missing its Diamond quad projection',
    );
  const rows = await db
    .prepare(
      `SELECT entity_id, entity_json, deleted_at, redirect_to
       FROM taproot_entities ORDER BY entity_id`,
    )
    .all<{
      entity_id: EntityId;
      entity_json: string;
      deleted_at: string | null;
      redirect_to: EntityId | null;
    }>();
  const factory = new DataFactory();
  for (const row of rows.results) {
    const expected = lifecycleQuads(
      parseEntityJson(row.entity_json),
      row.deleted_at,
      row.redirect_to,
      baseIri,
      TAPROOT_RDF_VERSION,
      factory,
    )
      .map((quad) =>
        [
          encodeTerm(quad.subject).key,
          encodeTerm(quad.predicate).key,
          encodeTerm(quad.object).key,
          encodeTerm(quad.graph).key,
        ].join('\u0000'),
      )
      .sort();
    const actual = await db
      .prepare(
        `SELECT subject_key, predicate_key, object_key, graph_key
         FROM taproot_rdf_ownership WHERE entity_id = ?
         ORDER BY subject_key, predicate_key, object_key, graph_key`,
      )
      .bind(row.entity_id)
      .all<{
        subject_key: string;
        predicate_key: string;
        object_key: string;
        graph_key: string;
      }>();
    const keys = actual.results
      .map(({ subject_key, predicate_key, object_key, graph_key }) =>
        [subject_key, predicate_key, object_key, graph_key].join('\u0000'),
      )
      .sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected))
      throw new SchemaMismatchError(
        `Taproot RDF ownership backfill is incomplete for ${row.entity_id}`,
      );
  }
}

/** Uses JavaScript trim semantics, including Unicode whitespace, for parity with runtime validation. */
export const PERSISTED_STATEMENT_TEXT_PAGE_SIZE = 100;

export async function verifyPersistedStatementText(
  db: SqliteDatabaseLike,
): Promise<void> {
  let currentEntityId = '';
  while (true) {
    const page = await db
      .prepare(
        `/* taproot:statement-text-current-page */
         SELECT entity_id, revision, entity_json
         FROM taproot_entities
         WHERE entity_id > ?
         ORDER BY entity_id
         LIMIT ?`,
      )
      .bind(currentEntityId, PERSISTED_STATEMENT_TEXT_PAGE_SIZE)
      .all<PersistedStatementTextRow>();
    for (const row of page.results)
      validatePersistedStatementText(row, 'current');
    if (page.results.length < PERSISTED_STATEMENT_TEXT_PAGE_SIZE) break;
    currentEntityId = (page.results.at(-1) as PersistedStatementTextRow)
      .entity_id;
  }

  let historicalEntityId = '';
  let historicalRevision = -1;
  while (true) {
    const page = await db
      .prepare(
        `/* taproot:statement-text-history-page */
         SELECT entity_id, revision, entity_json
         FROM taproot_entity_revisions
         WHERE entity_id > ? OR (entity_id = ? AND revision > ?)
         ORDER BY entity_id, revision
         LIMIT ?`,
      )
      .bind(
        historicalEntityId,
        historicalEntityId,
        historicalRevision,
        PERSISTED_STATEMENT_TEXT_PAGE_SIZE,
      )
      .all<PersistedStatementTextRow>();
    for (const row of page.results)
      validatePersistedStatementText(row, 'historical');
    if (page.results.length < PERSISTED_STATEMENT_TEXT_PAGE_SIZE) break;
    const last = page.results.at(-1) as PersistedStatementTextRow;
    historicalEntityId = last.entity_id;
    historicalRevision = last.revision;
  }
}

interface PersistedStatementTextRow {
  entity_id: string;
  revision: number;
  entity_json: string;
}

function validatePersistedStatementText(
  row: PersistedStatementTextRow,
  source: 'current' | 'historical',
): void {
  let entity: unknown;
  try {
    entity = JSON.parse(row.entity_json);
  } catch (cause) {
    throw new SchemaMismatchError(
      `Taproot ${source} entity ${row.entity_id}@${row.revision} is not valid JSON`,
      { cause },
    );
  }
  if (!isRecord(entity) || !isRecord(entity.claims))
    throw new SchemaMismatchError(
      `Taproot ${source} entity ${row.entity_id}@${row.revision} has invalid claims`,
    );
  for (const statements of Object.values(entity.claims)) {
    if (!Array.isArray(statements))
      throw new SchemaMismatchError(
        `Taproot ${source} entity ${row.entity_id}@${row.revision} has an invalid claim group`,
      );
    for (const statement of statements) {
      if (
        !isRecord(statement) ||
        typeof statement.text !== 'string' ||
        statement.text.trim().length === 0
      )
        throw new SchemaMismatchError(
          `Taproot ${source} statement text is missing or blank at ${row.entity_id}@${row.revision}`,
        );
    }
  }
}

export async function verifyTaprootPackageSeeds(
  db: SqliteDatabaseLike,
): Promise<void> {
  const migrationSeeds = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM taproot_migrations
       WHERE (version = 1 AND name = 'initial')
          OR (version = 2 AND name = 'audit-and-operations')
          OR (version = 3 AND name = 'canonical-statement-text')
          OR (version = 4 AND name = 'canonical-authorization-policy')
          OR (version = 5 AND name = 'unified-search-source-events')
          OR (version = 6 AND name = 'unified-search-materialization-lifecycle')
          OR (version = 7 AND name = 'external-search-producers')`,
    )
    .all<{ count: number }>();
  const migrationSeedTotal = await db
    .prepare(`SELECT COUNT(*) AS count FROM taproot_migrations`)
    .all<{ count: number }>();
  if (
    Number(migrationSeeds.results[0]?.count ?? 0) !== 7 ||
    Number(migrationSeedTotal.results[0]?.count ?? 0) !== 7
  )
    throw new SchemaMismatchError(
      'Taproot package migration seeds are incomplete',
    );
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function inspectTaprootSchema(
  db: SqliteDatabaseLike,
): Promise<TaprootSchemaInspection> {
  const required = catalogObjectNames(taprootCurrentCatalogStatements, 'TABLE');
  const tables = await db
    .prepare(
      `SELECT name, sql FROM sqlite_schema
       WHERE type = 'table' AND name LIKE 'taproot_%'`,
    )
    .all<{ name: string; sql: string | null }>();
  const names = new Set(tables.results.map(({ name }) => name));
  const missingTables = required.filter((name) => !names.has(name));
  const nonStrictTables = tables.results
    .filter(
      ({ name, sql }) =>
        required.includes(name) && !/\)\s*STRICT\s*$/iu.test(sql ?? ''),
    )
    .map(({ name }) => name);
  const metadata = names.has('taproot_metadata')
    ? await db
        .prepare('SELECT metadata_key, metadata_value FROM taproot_metadata')
        .all<{ metadata_key: string; metadata_value: string }>()
    : { results: [] };
  const versions = Object.fromEntries(
    metadata.results.map(({ metadata_key, metadata_value }) => [
      metadata_key,
      metadata_value,
    ]),
  );
  const expected = {
    schema_version: TAPROOT_SCHEMA_VERSION,
    canonical_json_version: TAPROOT_JSON_VERSION,
    rdf_mapping_version: TAPROOT_RDF_VERSION,
  };
  const errors = missingTables.map((name) => `${name} is missing`);
  errors.push(...nonStrictTables.map((name) => `${name} is not STRICT`));
  const requiredRevisionColumns = [
    'attribution_json',
    'tags_json',
    'event_id',
    'content_hash',
    'parent_hash',
    'deleted_at',
    'redirect_to',
  ];
  const revisionColumns = names.has('taproot_entity_revisions')
    ? await db
        .prepare(`PRAGMA table_info(taproot_entity_revisions)`)
        .all<{ name: string }>()
    : { results: [] };
  const presentColumns = new Set(
    revisionColumns.results.map(({ name }) => name),
  );
  const missingColumns = requiredRevisionColumns.filter(
    (name) => !presentColumns.has(name),
  );
  const authorizationColumns: Readonly<Record<string, readonly string[]>> = {
    taproot_installation_authorization: [
      'singleton',
      'installation_id',
      'authorization_revision',
      'search_generation',
      'last_advance_id',
      'created_at',
      'updated_at',
    ],
    taproot_entity_authorization: [
      'entity_id',
      'installation_id',
      'workspace_id',
      'owner_principal_id',
      'visibility_json',
      'effective_visibility_json',
      'source_revision',
      'authorization_revision',
      'deleted_at',
      'event_id',
      'updated_at',
    ],
    taproot_entity_authorization_revisions: [
      'entity_id',
      'source_revision',
      'installation_id',
      'workspace_id',
      'owner_principal_id',
      'visibility_json',
      'effective_visibility_json',
      'authorization_revision',
      'deleted_at',
      'event_id',
      'created_at',
    ],
    taproot_statement_authorization: [
      'entity_id',
      'statement_id',
      'source_revision',
      'restrictions_json',
      'effective_visibility_json',
      'authorization_revision',
    ],
    taproot_statement_authorization_revisions: [
      'entity_id',
      'source_revision',
      'statement_id',
      'restrictions_json',
      'effective_visibility_json',
      'authorization_revision',
    ],
    taproot_authorization_projection_outbox: [
      'event_id',
      'entity_id',
      'source_revision',
      'authorization_revision',
      'search_generation',
      'operation',
      'state',
      'created_at',
    ],
    taproot_authorization_backfill_plans: [
      'plan_id',
      'installation_id',
      'base_authorization_revision',
      'manifest_json',
      'manifest_hash',
      'entity_count',
      'revision_count',
      'status',
      'created_by',
      'created_at',
      'completed_at',
    ],
    taproot_authorization_admin_audit: [
      'sequence',
      'audit_id',
      'event_type',
      'principal_id',
      'plan_id',
      'authorization_revision',
      'details_json',
      'created_at',
    ],
    taproot_installation_authorization_advances: [
      'advance_id',
      'installation_id',
      'from_revision',
      'to_revision',
      'search_generation',
      'domain',
      'principal_id',
      'reason',
      'created_at',
    ],
    taproot_unified_search_source_events: [
      'sequence',
      'event_id',
      'installation_id',
      'domain',
      'source_kind',
      'source_id',
      'operation',
      'change_class',
      'source_revision',
      'source_hash',
      'authorization_revision',
      'search_generation',
      'predecessor_event_id',
      'predecessor_sequence',
      'payload_hash',
      'created_at',
      'source_policy_revision',
    ],
    taproot_unified_search_source_registry: [
      'installation_id',
      'source_kind',
      'source_id',
      'domain',
      'current_event_id',
      'current_event_sequence',
      'operation',
      'change_class',
      'source_revision',
      'source_hash',
      'authorization_revision',
      'search_generation',
      'payload_hash',
      'updated_at',
      'source_policy_revision',
    ],
  };
  for (const [table, expectedColumns] of Object.entries(authorizationColumns)) {
    if (!names.has(table)) continue;
    const columns = await db
      .prepare(`PRAGMA table_info(${table})`)
      .all<{ name: string }>();
    const actualColumns = columns.results.map(({ name }) => name);
    if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
      errors.push(
        `${table} columns are ${actualColumns.join(',')}, expected ${expectedColumns.join(',')}`,
      );
    }
  }
  for (const table of required) {
    const actualSql = tables.results.find(({ name }) => name === table)?.sql;
    const expectedSql = taprootCurrentCatalogStatements.find((sql) =>
      new RegExp(
        `^\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\b`,
        'iu',
      ).test(sql),
    );
    if (
      actualSql == null ||
      expectedSql === undefined ||
      normalizeCatalogSql(actualSql) !== normalizeCatalogSql(expectedSql)
    )
      errors.push(`${table} definition does not match the package catalog`);
  }
  const requiredIndexes = catalogObjectNames(
    taprootCurrentCatalogStatements,
    'INDEX',
  );
  const indexRows = await db
    .prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'taproot_%'`,
    )
    .all<{ name: string }>();
  const presentIndexes = new Set(indexRows.results.map(({ name }) => name));
  const missingIndexes = requiredIndexes.filter(
    (name) => !presentIndexes.has(name),
  );
  const requiredTriggers = catalogObjectNames(
    taprootCurrentCatalogStatements,
    'TRIGGER',
  );
  const triggerRows = await db
    .prepare(
      `SELECT name, sql FROM sqlite_schema
       WHERE type = 'trigger' AND name LIKE 'taproot_%'`,
    )
    .all<{ name: string; sql: string | null }>();
  const presentTriggers = new Set(triggerRows.results.map(({ name }) => name));
  const missingTriggers = requiredTriggers.filter(
    (name) => !presentTriggers.has(name),
  );
  for (const trigger of requiredTriggers) {
    const actualSql = triggerRows.results.find(
      ({ name }) => name === trigger,
    )?.sql;
    if (actualSql == null) continue;
    const expectedSql = taprootCurrentCatalogStatements.find((sql) =>
      new RegExp(
        `^\\s*CREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${trigger}\\b`,
        'iu',
      ).test(sql),
    );
    if (
      expectedSql === undefined ||
      normalizeCatalogSql(actualSql) !== normalizeCatalogSql(expectedSql)
    )
      errors.push(`${trigger} definition does not match the package catalog`);
  }
  errors.push(
    ...missingColumns.map(
      (name) => `taproot_entity_revisions.${name} is missing`,
    ),
  );
  errors.push(...missingIndexes.map((name) => `${name} is missing`));
  errors.push(...missingTriggers.map((name) => `${name} is missing`));
  for (const [key, value] of Object.entries(expected)) {
    if (versions[key] !== value) {
      errors.push(`${key} is ${versions[key] ?? 'missing'}, expected ${value}`);
    }
  }
  return {
    valid: errors.length === 0,
    versions,
    missingTables,
    nonStrictTables,
    missingColumns,
    missingIndexes,
    missingTriggers,
    errors,
  };
}

/**
 * Verify the exact package-owned catalog before adopting a current pre-ledger
 * database. This is intentionally stricter than the operational inspection:
 * names alone must never authorize stamping an arbitrary look-alike schema.
 */
export async function isExactTaprootSchema(
  db: SqliteDatabaseLike,
): Promise<boolean> {
  return matchesExactCatalog(db, taprootCurrentCatalogStatements);
}

/** Exact migration-0004 predecessor catalog accepted by migration 0005. */
export async function isExactPreSearchSourceEventTaprootSchema(
  db: SqliteDatabaseLike,
): Promise<boolean> {
  return matchesExactCatalog(db, preSearchSourceEventTaprootSchemaStatements);
}

/** Exact migration-0005 predecessor catalog accepted by migration 0006. */
export async function isExactPreSearchMaterializationTaprootSchema(
  db: SqliteDatabaseLike,
): Promise<boolean> {
  return matchesExactCatalog(
    db,
    preSearchMaterializationTaprootSchemaStatements,
  );
}

/** Exact migration-0006 predecessor catalog accepted by migration 0007. */
export async function isExactPreExternalSearchProducerTaprootSchema(
  db: SqliteDatabaseLike,
): Promise<boolean> {
  return matchesExactCatalog(
    db,
    preExternalSearchProducerTaprootSchemaStatements,
  );
}

/** Exact package catalog immediately before canonical authorization migration 0004. */
export async function isExactPreAuthorizationTaprootSchema(
  db: SqliteDatabaseLike,
): Promise<boolean> {
  return matchesExactCatalog(db, preAuthorizationTaprootSchemaStatements);
}

export async function isExactTaprootUpgradeSchema(
  db: SqliteDatabaseLike,
): Promise<boolean> {
  return matchesExactCatalog(db, taprootUpgradeCatalogStatements);
}

export async function isExactTaprootPreFinalizeSchema(
  db: SqliteDatabaseLike,
): Promise<boolean> {
  return matchesExactCatalog(db, taprootPreFinalizeCatalogStatements);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function matchesExactCatalog(
  db: SqliteDatabaseLike,
  statements: readonly string[],
): Promise<boolean> {
  const expected = new Map<string, string>();
  for (const sql of statements) {
    const match =
      /^\s*CREATE\s+(TABLE|INDEX|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)/iu.exec(
        sql,
      );
    if (!match?.[1] || !match[2]) continue;
    expected.set(
      `${match[1].toLowerCase()}:${match[2]}`,
      normalizeCatalogSql(sql),
    );
  }
  const catalog = await db
    .prepare(
      `SELECT type, name, sql FROM sqlite_schema
       WHERE name LIKE 'taproot_%' AND type IN ('table', 'index', 'trigger')
       ORDER BY type, name`,
    )
    .all<{ type: string; name: string; sql: string | null }>();
  if (catalog.results.length !== expected.size) return false;
  for (const entry of catalog.results) {
    const expectedSql = expected.get(`${entry.type}:${entry.name}`);
    if (
      expectedSql === undefined ||
      entry.sql === null ||
      normalizeCatalogSql(entry.sql) !== expectedSql
    )
      return false;
  }
  return true;
}

function catalogObjectNames(
  statements: readonly string[],
  kind: 'TABLE' | 'INDEX' | 'TRIGGER',
): string[] {
  const pattern = new RegExp(
    `^\\s*CREATE\\s+${kind}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?([a-z0-9_]+)`,
    'iu',
  );
  return statements.flatMap((sql) => {
    const name = pattern.exec(sql)?.[1];
    return name ? [name] : [];
  });
}

function normalizeCatalogSql(sql: string): string {
  return sql
    .replace(/\bIF\s+NOT\s+EXISTS\s+/giu, '')
    .replace(/\s+/gu, ' ')
    .replace(/;\s*$/u, '')
    .trim()
    .toLowerCase();
}

export async function assertTaprootSchema(
  db: SqliteDatabaseLike,
): Promise<void> {
  const inspection = await inspectTaprootSchema(db);
  if (!inspection.valid) {
    throw new SchemaMismatchError(inspection.errors.join('; '));
  }
}
