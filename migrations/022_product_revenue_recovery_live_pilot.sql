-- Product: Revenue Recovery live pilot v1 (web form ingress + Resend email).
-- NOT Phase 25. Additive on 021. Does not rewrite prior migrations.
-- Schema is host/provider-neutral (no website-host-specific objects).

ALTER TABLE revenue_recovery_attempts
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS revenue_recovery_attempts_provider_msg_uq
  ON revenue_recovery_attempts (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS revenue_recovery_provider_events (
  provider_event_id TEXT PRIMARY KEY,
  provider_name TEXT NOT NULL,
  provider_event_key TEXT NOT NULL,
  provider_message_id TEXT,
  event_kind TEXT NOT NULL,
  attempt_id TEXT,
  recovery_case_id TEXT,
  lead_id TEXT,
  customer_account_id TEXT,
  project_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS revenue_recovery_provider_events_key_uq
  ON revenue_recovery_provider_events (provider_name, provider_event_key);

CREATE INDEX IF NOT EXISTS revenue_recovery_provider_events_msg_idx
  ON revenue_recovery_provider_events (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
