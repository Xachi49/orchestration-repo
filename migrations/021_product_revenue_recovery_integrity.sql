-- Product: Revenue Recovery integrity closure (authority + economic provenance).
-- NOT Phase 25. Additive product migration on Phases 0–24 + 020.
-- Applied only when 020 is already present; does not rewrite 020 history.

ALTER TABLE revenue_recovery_attempts
  ADD COLUMN IF NOT EXISTS execution_action_identity TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS revenue_recovery_attempts_exec_identity_uq
  ON revenue_recovery_attempts (execution_action_identity)
  WHERE execution_action_identity IS NOT NULL;

ALTER TABLE revenue_recovery_lead_events
  ADD COLUMN IF NOT EXISTS trust_provenance TEXT;

ALTER TABLE revenue_recovery_attributions
  ADD COLUMN IF NOT EXISTS trust_provenance TEXT;
