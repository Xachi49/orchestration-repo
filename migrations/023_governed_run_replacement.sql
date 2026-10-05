-- Governed same-objective run replacement.
-- Existing rows hydrate as run_attempt = 1. No truncate, no table rewrite.
-- runs_idempotency_key_uq is preserved.

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS run_attempt INTEGER NOT NULL DEFAULT 1;

ALTER TABLE runs
  DROP CONSTRAINT IF EXISTS runs_run_attempt_positive;

ALTER TABLE runs
  ADD CONSTRAINT runs_run_attempt_positive CHECK (run_attempt > 0);

DROP INDEX IF EXISTS runs_logical_identity_uq;

CREATE UNIQUE INDEX runs_logical_identity_uq
  ON runs (
    project_id,
    objective_id,
    objective_version,
    requested_environment,
    run_attempt
  );
