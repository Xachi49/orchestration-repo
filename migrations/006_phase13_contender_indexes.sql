-- Phase 13 integrity: project-aware schedulable contender indexes.
-- Fairness discovers projects with currently schedulable work, not a work-item page.

CREATE INDEX IF NOT EXISTS scheduler_work_items_eligible_project_idx
  ON scheduler_work_items (status, project_id, eligible_at)
  WHERE status IN ('WAITING', 'ELIGIBLE', 'BLOCKED_DEPENDENCY');

CREATE INDEX IF NOT EXISTS scheduler_work_items_project_eligible_at_idx
  ON scheduler_work_items (project_id, status, eligible_at)
  WHERE status = 'ELIGIBLE';
