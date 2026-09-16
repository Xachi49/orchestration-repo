-- Product: Continuum Revenue Recovery Engine
-- NOT Phase 25. Product migration on Phases 0–24 platform.

CREATE TABLE IF NOT EXISTS revenue_recovery_leads (
  lead_id TEXT PRIMARY KEY,
  customer_account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source TEXT NOT NULL,
  external_lead_id TEXT NOT NULL,
  material_fingerprint TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS revenue_recovery_leads_source_uq
  ON revenue_recovery_leads (customer_account_id, source, external_lead_id);
CREATE INDEX IF NOT EXISTS revenue_recovery_leads_project_idx
  ON revenue_recovery_leads (customer_account_id, project_id);

CREATE TABLE IF NOT EXISTS revenue_recovery_lead_events (
  event_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  customer_account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  recorded_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS revenue_recovery_lead_events_source_uq
  ON revenue_recovery_lead_events (customer_account_id, lead_id, source, external_event_id);
CREATE INDEX IF NOT EXISTS revenue_recovery_lead_events_lead_idx
  ON revenue_recovery_lead_events (lead_id, occurred_at);

CREATE TABLE IF NOT EXISTS revenue_recovery_config (
  config_id TEXT PRIMARY KEY,
  customer_account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  config_version BIGINT NOT NULL,
  config_fingerprint TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS revenue_recovery_config_version_uq
  ON revenue_recovery_config (customer_account_id, project_id, config_version);

CREATE TABLE IF NOT EXISTS revenue_recovery_cases (
  recovery_case_id TEXT PRIMARY KEY,
  gap_identity_key TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  customer_account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS revenue_recovery_cases_gap_uq
  ON revenue_recovery_cases (gap_identity_key);
CREATE INDEX IF NOT EXISTS revenue_recovery_cases_project_idx
  ON revenue_recovery_cases (customer_account_id, project_id, status);
CREATE INDEX IF NOT EXISTS revenue_recovery_cases_lead_idx
  ON revenue_recovery_cases (lead_id);

CREATE TABLE IF NOT EXISTS revenue_recovery_templates (
  template_id TEXT NOT NULL,
  version BIGINT NOT NULL,
  customer_account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (template_id, version)
);
CREATE INDEX IF NOT EXISTS revenue_recovery_templates_project_idx
  ON revenue_recovery_templates (customer_account_id, project_id, channel);

CREATE TABLE IF NOT EXISTS revenue_recovery_attempts (
  attempt_id TEXT PRIMARY KEY,
  recovery_case_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  customer_account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS revenue_recovery_attempts_case_idx
  ON revenue_recovery_attempts (recovery_case_id, sent_at);

CREATE TABLE IF NOT EXISTS revenue_recovery_attributions (
  attribution_id TEXT PRIMARY KEY,
  recovery_case_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  customer_account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  attribution_type TEXT NOT NULL,
  confidence_class TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL,
  payload JSONB NOT NULL,
  attributed_at TIMESTAMPTZ NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS revenue_recovery_attributions_case_idx
  ON revenue_recovery_attributions (recovery_case_id);

CREATE TABLE IF NOT EXISTS revenue_recovery_records (
  recovery_record_id TEXT PRIMARY KEY,
  recovery_case_id TEXT NOT NULL UNIQUE,
  lead_id TEXT NOT NULL,
  customer_account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS revenue_recovery_audit_events (
  event_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  customer_account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  lead_id TEXT,
  recovery_case_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS revenue_recovery_audit_case_idx
  ON revenue_recovery_audit_events (recovery_case_id, occurred_at);
