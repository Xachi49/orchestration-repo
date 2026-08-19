-- Phase 11 durable schema. Ordered, checksumable, non-destructive.
-- APPLICATION CLOCK != DISTRIBUTED LEASE CLOCK: lease expiry uses NOW().

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS migration_lock (
  lock_id INTEGER PRIMARY KEY CHECK (lock_id = 1),
  owner_id TEXT,
  locked_at TIMESTAMPTZ
);

INSERT INTO migration_lock (lock_id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS capabilities (
  capability_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS policy_bundles (
  policy_bundle_id TEXT PRIMARY KEY,
  policy_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budget_profiles (
  budget_profile_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  objective_version INTEGER NOT NULL CHECK (objective_version > 0),
  requested_environment TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1 CHECK (record_revision >= 1),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency_key_uq
  ON runs (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS runs_logical_identity_uq
  ON runs (project_id, objective_id, objective_version, requested_environment);
CREATE INDEX IF NOT EXISTS runs_project_idx ON runs (project_id);

CREATE TABLE IF NOT EXISTS objectives (
  project_id TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  objective_version INTEGER NOT NULL CHECK (objective_version > 0),
  fingerprint TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (project_id, objective_id, objective_version)
);

CREATE TABLE IF NOT EXISTS objective_run_bindings (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  objective_version INTEGER NOT NULL CHECK (objective_version > 0)
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS events_run_idx ON events (run_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  run_id TEXT,
  payload JSONB NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS project_locks (
  project_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS coordinator_leases (
  coordination_key TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  fence_token BIGINT NOT NULL CHECK (fence_token >= 0),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS coordinator_fences (
  coordination_key TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  project_id TEXT,
  run_id TEXT,
  fence_token BIGINT NOT NULL CHECK (fence_token >= 0),
  owner_id TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1 CHECK (record_revision >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS coordinator_fences_run_idx
  ON coordinator_fences (run_id);

CREATE TABLE IF NOT EXISTS json_documents (
  collection TEXT NOT NULL,
  document_id TEXT NOT NULL,
  project_id TEXT,
  run_id TEXT,
  unique_key TEXT,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1 CHECK (record_revision >= 1),
  immutable BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection, document_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS json_documents_unique_key_uq
  ON json_documents (collection, unique_key)
  WHERE unique_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS json_documents_run_idx
  ON json_documents (collection, run_id);
CREATE INDEX IF NOT EXISTS json_documents_project_idx
  ON json_documents (collection, project_id);

CREATE TABLE IF NOT EXISTS artifact_blobs (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  execution_attempt_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0 AND byte_size <= 1048576),
  media_type TEXT NOT NULL,
  content BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS artifact_blobs_run_idx ON artifact_blobs (run_id);

CREATE TABLE IF NOT EXISTS transactional_outbox (
  outbox_id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner_id TEXT,
  fence_token BIGINT CHECK (fence_token IS NULL OR fence_token >= 0),
  lease_expires_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS outbox_pending_idx
  ON transactional_outbox (status, available_at);

CREATE TABLE IF NOT EXISTS durable_inbox (
  message_id TEXT NOT NULL,
  consumer_name TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  result_fingerprint TEXT,
  payload JSONB,
  PRIMARY KEY (message_id, consumer_name)
);

CREATE TABLE IF NOT EXISTS nonce_state (
  approval_request_id TEXT PRIMARY KEY,
  nonce_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION protect_immutable_json_documents()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.immutable THEN
      RAISE EXCEPTION 'IMMUTABLE_RECORD_MUTATION: %.%', OLD.collection, OLD.document_id;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.immutable THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD_MUTATION: %.%', OLD.collection, OLD.document_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS json_documents_immutable ON json_documents;
CREATE TRIGGER json_documents_immutable
  BEFORE UPDATE OR DELETE ON json_documents
  FOR EACH ROW
  EXECUTE FUNCTION protect_immutable_json_documents();

CREATE OR REPLACE FUNCTION protect_events_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RECORD_MUTATION: events.%', COALESCE(OLD.event_id, '');
END;
$$;

DROP TRIGGER IF EXISTS events_immutable ON events;
CREATE TRIGGER events_immutable
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW
  EXECUTE FUNCTION protect_events_mutation();
