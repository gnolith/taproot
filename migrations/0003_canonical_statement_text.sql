-- Documentation copy of canonical JSON migration 3.
-- Hosts must use applyTaprootMigrations() so the package migration ledger is
-- updated atomically. No fallback statement prose is generated.
INSERT INTO taproot_assertions(assertion_key)
WITH canonical_json(entity_json) AS (
  SELECT entity_json FROM taproot_entities
  UNION ALL
  SELECT entity_json FROM taproot_entity_revisions
)
SELECT NULL
FROM canonical_json AS source,
  json_each(source.entity_json, '$.claims') AS claim,
  json_each(claim.value) AS statement
WHERE json_type(statement.value, '$.text') IS NOT 'text'
   OR trim(json_extract(statement.value, '$.text')) = ''
LIMIT 1;

UPDATE taproot_metadata SET metadata_value = '2'
WHERE metadata_key = 'canonical_json_version'
  AND metadata_value = '1';

INSERT INTO taproot_assertions(assertion_key)
SELECT NULL WHERE NOT EXISTS (
  SELECT 1 FROM taproot_metadata
  WHERE metadata_key = 'canonical_json_version'
    AND metadata_value = '2'
);

INSERT INTO taproot_migrations(version, name)
VALUES (3, 'canonical-statement-text')
ON CONFLICT(version) DO NOTHING;
