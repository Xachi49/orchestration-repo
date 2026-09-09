-- Phase 23: independent assurance, adversarial evaluation, system certification.

CREATE TABLE IF NOT EXISTS assurance_profiles (
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  profile_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (profile_id, profile_version)
);

CREATE TABLE IF NOT EXISTS assurance_runs (
  assurance_run_id TEXT PRIMARY KEY,
  target_fingerprint TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  profile_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS assurance_runs_target_idx
  ON assurance_runs (target_fingerprint);

CREATE TABLE IF NOT EXISTS assurance_challenge_plans (
  plan_id TEXT PRIMARY KEY,
  plan_hash TEXT NOT NULL,
  target_fingerprint TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS assurance_evidence (
  evidence_id TEXT PRIMARY KEY,
  assurance_run_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS assurance_evidence_run_idx
  ON assurance_evidence (assurance_run_id);

CREATE TABLE IF NOT EXISTS assurance_control_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  assurance_run_id TEXT NOT NULL,
  control_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS assurance_control_evaluations_run_control_uq
  ON assurance_control_evaluations (assurance_run_id, control_id);

CREATE TABLE IF NOT EXISTS assurance_findings (
  finding_id TEXT PRIMARY KEY,
  assurance_run_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS assurance_findings_run_idx
  ON assurance_findings (assurance_run_id);

CREATE TABLE IF NOT EXISTS assurance_assessments (
  assessment_id TEXT PRIMARY KEY,
  assurance_run_id TEXT NOT NULL,
  assessment_hash TEXT NOT NULL,
  outcome TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS assurance_assessments_run_uq
  ON assurance_assessments (assurance_run_id);

CREATE TABLE IF NOT EXISTS system_certificates (
  certificate_id TEXT PRIMARY KEY,
  certificate_hash TEXT NOT NULL,
  certification_material_fingerprint TEXT NOT NULL,
  target_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS system_certificates_material_uq
  ON system_certificates (certification_material_fingerprint);

CREATE TABLE IF NOT EXISTS system_certificate_revocations (
  revocation_id TEXT PRIMARY KEY,
  certificate_id TEXT NOT NULL,
  revocation_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS system_certificate_revocations_cert_idx
  ON system_certificate_revocations (certificate_id);

CREATE TABLE IF NOT EXISTS assurance_audit_events (
  audit_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  assurance_run_id TEXT,
  certificate_id TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS assurance_audit_events_run_idx
  ON assurance_audit_events (assurance_run_id);

-- Authority grant identity is grant_id (immutable issuance), not
-- (principal, role, project). The Phase 11 unique index conflated
-- bootstrap idempotency with issuance identity and blocked legitimate
-- regrant after authority_revocations overlay. Drop it; keep a lookup index.
DROP INDEX IF EXISTS authority_grants_principal_uq;
CREATE INDEX IF NOT EXISTS authority_grants_principal_lookup_idx
  ON authority_grants (principal_id, principal_type, project_id);

-- Extend authority_grants principal_type for Phase 23 assurance roles.
ALTER TABLE authority_grants DROP CONSTRAINT IF EXISTS authority_grants_principal_type_check;
ALTER TABLE authority_grants ADD CONSTRAINT authority_grants_principal_type_check
  CHECK (principal_type IN (
    'REQUESTER',
    'APPROVER',
    'PROGRAM_MATERIALIZER',
    'PORTFOLIO_ALLOCATOR',
    'STRATEGY_SELECTOR',
    'EXPERIMENT_SPONSOR',
    'CAUSAL_REVIEWER',
    'DECISION_POLICY_APPROVER',
    'DECISION_POLICY_ACTIVATOR',
    'GOVERNANCE_ADMIN',
    'GOVERNANCE_HOLD_OPERATOR',
    'RISK_REVIEWER',
    'SECURITY_REVIEWER',
    'CONSTITUTIONAL_REVIEWER',
    'CONSTITUTIONAL_ACTIVATOR',
    'FEDERATION_NEGOTIATOR',
    'FEDERATION_RATIFIER',
    'FEDERATION_WORK_ACCEPTOR',
    'FEDERATION_EVIDENCE_SHARER',
    'ASSURANCE_OPERATOR',
    'ASSURANCE_CERTIFIER'
  ));
