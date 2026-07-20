CREATE TABLE taproot_entities (
  entity_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('item', 'property')),
  datatype TEXT,
  revision INTEGER NOT NULL,
  entity_json TEXT NOT NULL CHECK (json_valid(entity_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  redirect_to TEXT,
  CHECK (
    (entity_type = 'item' AND datatype IS NULL)
    OR (entity_type = 'property' AND datatype IS NOT NULL)
  )
) STRICT;

CREATE TABLE taproot_entity_revisions (
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  entity_json TEXT NOT NULL CHECK (json_valid(entity_json)),
  actor TEXT,
  edit_summary TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_id, revision),
  FOREIGN KEY (entity_id) REFERENCES taproot_entities(entity_id)
) STRICT;

CREATE TABLE taproot_id_counters (
  entity_type TEXT PRIMARY KEY CHECK (entity_type IN ('item', 'property')),
  next_numeric_id INTEGER NOT NULL CHECK (next_numeric_id > 0)
) STRICT;

CREATE TABLE taproot_terms (
  entity_id TEXT NOT NULL,
  language TEXT NOT NULL,
  term_type TEXT NOT NULL CHECK (term_type IN ('label', 'description', 'alias')),
  value TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entity_id, language, term_type, ordinal),
  FOREIGN KEY (entity_id) REFERENCES taproot_entities(entity_id)
) STRICT;

CREATE TABLE taproot_metadata (
  metadata_key TEXT PRIMARY KEY,
  metadata_value TEXT NOT NULL
) STRICT;

CREATE TABLE taproot_assertions (
  assertion_key TEXT PRIMARY KEY
) STRICT;

CREATE INDEX taproot_entities_type_idx ON taproot_entities(entity_type, entity_id);
CREATE INDEX taproot_entities_modified_idx ON taproot_entities(modified_at, entity_id);
CREATE INDEX taproot_revisions_entity_idx ON taproot_entity_revisions(entity_id, revision DESC);
CREATE INDEX taproot_terms_lookup_idx ON taproot_terms(language, value COLLATE NOCASE, entity_id);

INSERT INTO taproot_id_counters(entity_type, next_numeric_id)
VALUES ('item', 1), ('property', 1);

INSERT INTO taproot_metadata(metadata_key, metadata_value)
VALUES
  ('schema_version', '1'),
  ('canonical_json_version', '1'),
  ('rdf_mapping_version', '1');
