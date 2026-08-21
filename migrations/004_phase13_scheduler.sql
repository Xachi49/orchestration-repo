-- Phase 13: durable portfolio scheduler work, dependencies, decisions, config, pauses.
-- SCHEDULING != AUTHORITY. Work item status is scheduler-local only.

CREATE TABLE IF NOT EXISTS scheduler_work_items (
  work_item_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  work_kind TEXT NOT NULL
    CHECK (work_kind IN (
      'INGEST_REPOSITORY',
      'PLAN_RUN',
      'VALIDATE_PLAN',
      'ROUTE_AUTHORIZATION',
      'EXECUTE_PLAN',
      'VERIFY_OUTCOME',
      'LEARN_FROM_RUN',
      'BUILD_OBSERVABILITY'
    )),
  status TEXT NOT NULL
    CHECK (status IN (
      'WAITING',
      'BLOCKED_DEPENDENCY',
      'ELIGIBLE',
      'CLAIMED',
      'RUNNING',
      'SUCCEEDED',
      'FAILED',
      'CONTAINED',
      'CANCELLED'
    )),
  priority_class TEXT NOT NULL
    CHECK (priority_class IN (
      'CRITICAL', 'HIGH', 'NORMAL', 'LOW', 'BACKGROUND'
    )),
  logical_identity_key TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  eligible_at TIMESTAMPTZ NOT NULL,
  deadline_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  record_revision BIGINT NOT NULL DEFAULT 1,
  dependency_set_hash TEXT NOT NULL,
  scheduling_metadata_hash TEXT NOT NULL,
  claim_owner_id TEXT,
  fence_token BIGINT,
  lease_expires_at TIMESTAMPTZ,
  failure_class TEXT,
  failure_reason_code TEXT,
  last_error_safe_message TEXT,
  result_ref TEXT,
  last_decision_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS scheduler_work_items_identity_uq
  ON scheduler_work_items (logical_identity_key);
CREATE INDEX IF NOT EXISTS scheduler_work_items_status_eligible_idx
  ON scheduler_work_items (status, eligible_at);
CREATE INDEX IF NOT EXISTS scheduler_work_items_project_status_idx
  ON scheduler_work_items (project_id, status);
CREATE INDEX IF NOT EXISTS scheduler_work_items_run_idx
  ON scheduler_work_items (run_id);

CREATE TABLE IF NOT EXISTS scheduler_dependencies (
  dependency_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  dependent_run_id TEXT NOT NULL,
  prerequisite_run_id TEXT NOT NULL,
  required_milestone TEXT NOT NULL
    CHECK (required_milestone IN (
      'REPOSITORY_VERIFIED',
      'PLAN_VALIDATED',
      'APPROVED',
      'COMPLETED'
    )),
  created_at TIMESTAMPTZ NOT NULL,
  dependency_hash TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT scheduler_dependencies_no_self
    CHECK (dependent_run_id <> prerequisite_run_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS scheduler_dependencies_edge_uq
  ON scheduler_dependencies (
    dependent_run_id, prerequisite_run_id, required_milestone
  );
CREATE INDEX IF NOT EXISTS scheduler_dependencies_dependent_idx
  ON scheduler_dependencies (dependent_run_id);
CREATE INDEX IF NOT EXISTS scheduler_dependencies_project_idx
  ON scheduler_dependencies (project_id);

CREATE TABLE IF NOT EXISTS scheduler_decisions (
  decision_id TEXT PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  selected_work_id TEXT,
  reason_code TEXT NOT NULL,
  payload JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS scheduler_decisions_selected_idx
  ON scheduler_decisions (selected_work_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS scheduler_decisions_ts_idx
  ON scheduler_decisions (timestamp DESC);

CREATE TABLE IF NOT EXISTS scheduler_project_config (
  project_id TEXT PRIMARY KEY,
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 10),
  max_concurrency INTEGER NOT NULL DEFAULT 4 CHECK (max_concurrency BETWEEN 1 AND 64),
  default_priority_class TEXT NOT NULL DEFAULT 'NORMAL'
    CHECK (default_priority_class IN (
      'CRITICAL', 'HIGH', 'NORMAL', 'LOW', 'BACKGROUND'
    )),
  record_revision BIGINT NOT NULL DEFAULT 1,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS scheduler_pauses (
  pause_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('GLOBAL', 'PROJECT')),
  project_id TEXT,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by_principal_id TEXT NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS scheduler_pauses_global_uq
  ON scheduler_pauses ((scope))
  WHERE scope = 'GLOBAL';
CREATE UNIQUE INDEX IF NOT EXISTS scheduler_pauses_project_uq
  ON scheduler_pauses (project_id)
  WHERE scope = 'PROJECT' AND project_id IS NOT NULL;

-- Indexed discovery of non-terminal progression runs.
CREATE INDEX IF NOT EXISTS runs_state_updated_idx
  ON runs (state, updated_at DESC);
