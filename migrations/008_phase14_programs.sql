-- Phase 14: governed programs, plans, budget escrow, lineage, materialization, completion.

CREATE TABLE IF NOT EXISTS programs (
  program_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  program_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS programs_idempotency_uq
  ON programs (idempotency_key);
CREATE INDEX IF NOT EXISTS programs_project_idx
  ON programs (project_id);
CREATE INDEX IF NOT EXISTS programs_status_updated_idx
  ON programs (status, updated_at ASC, program_id ASC);

CREATE TABLE IF NOT EXISTS program_plans (
  program_id TEXT NOT NULL,
  program_plan_version INTEGER NOT NULL,
  program_plan_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (program_id, program_plan_version)
);

CREATE TABLE IF NOT EXISTS program_budget_ledgers (
  program_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS program_budget_reservations (
  reservation_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS program_budget_reservations_node_uq
  ON program_budget_reservations (program_id, node_id);

CREATE TABLE IF NOT EXISTS program_lineage (
  lineage_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  program_plan_version INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  child_run_id TEXT,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS program_lineage_program_plan_idx
  ON program_lineage (program_id, program_plan_version);

CREATE TABLE IF NOT EXISTS program_materialization_approvals (
  approval_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS program_materialization_approvals_program_idx
  ON program_materialization_approvals (program_id, status);

CREATE TABLE IF NOT EXISTS program_completion_records (
  program_completion_record_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
