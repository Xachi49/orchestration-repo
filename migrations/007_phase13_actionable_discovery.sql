-- Phase 13: actionable discovery indexes (starvation protection).
-- Discovery prefers Runs whose current-phase work is not yet materialized.

CREATE INDEX IF NOT EXISTS scheduler_work_items_run_kind_idx
  ON scheduler_work_items (run_id, work_kind);

CREATE INDEX IF NOT EXISTS runs_discoverable_updated_asc_idx
  ON runs (updated_at ASC, run_id ASC)
  WHERE state IN (
    'ADMITTED',
    'INGESTING',
    'VALIDATING',
    'REVISING',
    'APPROVED',
    'EXECUTING',
    'COMPLETED'
  );
