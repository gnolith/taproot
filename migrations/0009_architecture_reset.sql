-- Taproot 0.5 architecture reset.
--
-- The executable, checksummed migration also includes the bounded,
-- catalog-preserving rebuild prepared by
-- prepareArchitectureResetStorageStatements() in src/schema.ts.

CREATE TABLE IF NOT EXISTS taproot_workshop_idempotency (
  installation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, idempotency_key)
) STRICT;

INSERT INTO taproot_metadata(metadata_key, metadata_value)
VALUES ('schema_version', '9')
ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value;

INSERT INTO taproot_migrations(version, name)
VALUES (9, 'architecture-reset')
ON CONFLICT(version) DO NOTHING;
