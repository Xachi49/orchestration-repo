-- Execution resource ledger: durable Phase 7 budget authority per attempt.

CREATE TABLE IF NOT EXISTS execution_resource_ledgers (
  execution_attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  budget_profile_id TEXT NOT NULL,
  api_calls INTEGER NOT NULL DEFAULT 0 CHECK (api_calls >= 0),
  duration_ms BIGINT NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  reserved_duration_ms BIGINT NOT NULL DEFAULT 0 CHECK (reserved_duration_ms >= 0),
  test_executions INTEGER NOT NULL DEFAULT 0 CHECK (test_executions >= 0),
  task_creations INTEGER NOT NULL DEFAULT 0 CHECK (task_creations >= 0),
  artifact_bytes BIGINT NOT NULL DEFAULT 0 CHECK (artifact_bytes >= 0),
  steps_executed INTEGER NOT NULL DEFAULT 0 CHECK (steps_executed >= 0),
  ceiling_duration_ms BIGINT NOT NULL CHECK (ceiling_duration_ms > 0),
  ceiling_api_calls INTEGER NOT NULL CHECK (ceiling_api_calls >= 0),
  ceiling_plan_steps INTEGER NOT NULL CHECK (ceiling_plan_steps >= 0),
  record_revision BIGINT NOT NULL DEFAULT 1 CHECK (record_revision >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS execution_resource_ledgers_run_attempt_uq
  ON execution_resource_ledgers (run_id, execution_attempt_id);
CREATE INDEX IF NOT EXISTS execution_resource_ledgers_run_idx
  ON execution_resource_ledgers (run_id);
CREATE INDEX IF NOT EXISTS execution_resource_ledgers_project_idx
  ON execution_resource_ledgers (project_id);
