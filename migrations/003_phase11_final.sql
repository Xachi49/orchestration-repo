-- Phase 11 final acceptance: durable authority directory and encrypted delivery secrets.

CREATE TABLE IF NOT EXISTS authority_grants (
  grant_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('REQUESTER', 'APPROVER')),
  project_id TEXT NOT NULL,
  authorized_environments JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  authority_version TEXT NOT NULL DEFAULT '1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS authority_grants_principal_uq
  ON authority_grants (principal_id, principal_type, project_id);
CREATE INDEX IF NOT EXISTS authority_grants_project_idx
  ON authority_grants (project_id);

CREATE TABLE IF NOT EXISTS approval_delivery_secrets (
  approval_request_id TEXT PRIMARY KEY,
  secret_ciphertext BYTEA NOT NULL,
  secret_iv BYTEA NOT NULL,
  secret_tag BYTEA NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'DELIVERED', 'INVALIDATED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS approval_delivery_secrets_status_idx
  ON approval_delivery_secrets (status);
