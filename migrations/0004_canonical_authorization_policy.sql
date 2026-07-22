CREATE TABLE IF NOT EXISTS taproot_installation_authorization (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  installation_id TEXT NOT NULL UNIQUE,
  authorization_revision INTEGER NOT NULL CHECK (authorization_revision >= 1),
  search_generation INTEGER NOT NULL CHECK (search_generation >= 1),
  last_advance_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS taproot_entity_authorization (
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
) STRICT;

CREATE TABLE IF NOT EXISTS taproot_entity_authorization_revisions (
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
) STRICT;

CREATE TABLE IF NOT EXISTS taproot_statement_authorization (
  entity_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  restrictions_json TEXT NOT NULL CHECK (json_valid(restrictions_json)),
  effective_visibility_json TEXT NOT NULL CHECK (json_valid(effective_visibility_json)),
  authorization_revision INTEGER NOT NULL,
  PRIMARY KEY (entity_id, statement_id),
  FOREIGN KEY (entity_id) REFERENCES taproot_entities(entity_id)
) STRICT;

CREATE TABLE IF NOT EXISTS taproot_statement_authorization_revisions (
  entity_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  statement_id TEXT NOT NULL,
  restrictions_json TEXT NOT NULL CHECK (json_valid(restrictions_json)),
  effective_visibility_json TEXT NOT NULL CHECK (json_valid(effective_visibility_json)),
  authorization_revision INTEGER NOT NULL,
  PRIMARY KEY (entity_id, source_revision, statement_id),
  FOREIGN KEY (entity_id, source_revision)
    REFERENCES taproot_entity_revisions(entity_id, revision)
) STRICT;

CREATE TABLE IF NOT EXISTS taproot_authorization_projection_outbox (
  event_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  authorization_revision INTEGER NOT NULL,
  search_generation INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'repair', 'backfill')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'complete')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES taproot_audit_events(event_id)
) STRICT;

CREATE TABLE IF NOT EXISTS taproot_authorization_backfill_plans (
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
) STRICT;

CREATE TABLE IF NOT EXISTS taproot_authorization_admin_audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN ('backfill-plan', 'backfill-apply')),
  principal_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  authorization_revision INTEGER NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES taproot_authorization_backfill_plans(plan_id)
) STRICT;

CREATE TABLE IF NOT EXISTS taproot_installation_authorization_advances (
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
) STRICT;

CREATE INDEX IF NOT EXISTS taproot_entity_authorization_candidate_idx
  ON taproot_entity_authorization(installation_id, deleted_at, entity_id);
CREATE INDEX IF NOT EXISTS taproot_entity_authorization_revision_idx
  ON taproot_entity_authorization_revisions(entity_id, source_revision DESC);
CREATE INDEX IF NOT EXISTS taproot_statement_authorization_candidate_idx
  ON taproot_statement_authorization(entity_id, source_revision, statement_id);
CREATE INDEX IF NOT EXISTS taproot_authorization_outbox_state_idx
  ON taproot_authorization_projection_outbox(state, authorization_revision, event_id);

CREATE TRIGGER IF NOT EXISTS taproot_installation_identity_no_update
  BEFORE UPDATE OF installation_id ON taproot_installation_authorization
  BEGIN SELECT RAISE(ABORT, 'taproot installation identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS taproot_installation_authorization_no_delete
  BEFORE DELETE ON taproot_installation_authorization
  BEGIN SELECT RAISE(ABORT, 'taproot installation authorization is durable'); END;
CREATE TRIGGER IF NOT EXISTS taproot_installation_authorization_no_replace
  BEFORE INSERT ON taproot_installation_authorization
  WHEN EXISTS (SELECT 1 FROM taproot_installation_authorization WHERE singleton = NEW.singleton)
  BEGIN SELECT RAISE(ABORT, 'taproot installation authorization cannot be replaced'); END;
CREATE TRIGGER IF NOT EXISTS taproot_entity_authorization_revisions_no_update
  BEFORE UPDATE ON taproot_entity_authorization_revisions
  BEGIN SELECT RAISE(ABORT, 'taproot authorization revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS taproot_entity_authorization_revisions_no_delete
  BEFORE DELETE ON taproot_entity_authorization_revisions
  BEGIN SELECT RAISE(ABORT, 'taproot authorization revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS taproot_entity_authorization_revisions_no_replace
  BEFORE INSERT ON taproot_entity_authorization_revisions
  WHEN EXISTS (
    SELECT 1 FROM taproot_entity_authorization_revisions
    WHERE entity_id = NEW.entity_id AND source_revision = NEW.source_revision
  )
  BEGIN SELECT RAISE(ABORT, 'taproot authorization revisions cannot be replaced'); END;
CREATE TRIGGER IF NOT EXISTS taproot_statement_authorization_revisions_no_update
  BEFORE UPDATE ON taproot_statement_authorization_revisions
  BEGIN SELECT RAISE(ABORT, 'taproot statement authorization revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS taproot_statement_authorization_revisions_no_delete
  BEFORE DELETE ON taproot_statement_authorization_revisions
  BEGIN SELECT RAISE(ABORT, 'taproot statement authorization revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS taproot_statement_authorization_revisions_no_replace
  BEFORE INSERT ON taproot_statement_authorization_revisions
  WHEN EXISTS (
    SELECT 1 FROM taproot_statement_authorization_revisions
    WHERE entity_id = NEW.entity_id AND source_revision = NEW.source_revision
      AND statement_id = NEW.statement_id
  )
  BEGIN SELECT RAISE(ABORT, 'taproot statement authorization revisions cannot be replaced'); END;
CREATE TRIGGER IF NOT EXISTS taproot_authorization_admin_audit_no_update
  BEFORE UPDATE ON taproot_authorization_admin_audit
  BEGIN SELECT RAISE(ABORT, 'taproot authorization administration audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS taproot_authorization_admin_audit_no_delete
  BEFORE DELETE ON taproot_authorization_admin_audit
  BEGIN SELECT RAISE(ABORT, 'taproot authorization administration audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS taproot_authorization_admin_audit_no_replace
  BEFORE INSERT ON taproot_authorization_admin_audit
  WHEN EXISTS (
    SELECT 1 FROM taproot_authorization_admin_audit
    WHERE sequence = NEW.sequence OR audit_id = NEW.audit_id
  )
  BEGIN SELECT RAISE(ABORT, 'taproot authorization administration audit cannot be replaced'); END;
CREATE TRIGGER IF NOT EXISTS taproot_installation_authorization_advances_no_update
  BEFORE UPDATE ON taproot_installation_authorization_advances
  BEGIN SELECT RAISE(ABORT, 'taproot authorization advances are immutable'); END;
CREATE TRIGGER IF NOT EXISTS taproot_installation_authorization_advances_no_delete
  BEFORE DELETE ON taproot_installation_authorization_advances
  BEGIN SELECT RAISE(ABORT, 'taproot authorization advances are immutable'); END;
CREATE TRIGGER IF NOT EXISTS taproot_installation_authorization_advances_no_replace
  BEFORE INSERT ON taproot_installation_authorization_advances
  WHEN EXISTS (
    SELECT 1 FROM taproot_installation_authorization_advances
    WHERE advance_id = NEW.advance_id
  )
  BEGIN SELECT RAISE(ABORT, 'taproot authorization advances cannot be replaced'); END;

INSERT INTO taproot_metadata(metadata_key, metadata_value)
  VALUES ('schema_version', '3')
  ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value;
INSERT INTO taproot_migrations(version, name)
  VALUES (4, 'canonical-authorization-policy')
  ON CONFLICT(version) DO NOTHING;
