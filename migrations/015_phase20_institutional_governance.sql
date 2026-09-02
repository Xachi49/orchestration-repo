-- Phase 20: institutional governance — institutions, units, mandates,
-- delegations, cases, attestations, proofs, revocations, holds, snapshots, audit.

CREATE TABLE IF NOT EXISTS institutions (
  institution_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS organizational_units (
  organizational_unit_id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS organizational_units_institution_idx
  ON organizational_units (institution_id);

CREATE TABLE IF NOT EXISTS governance_mandates (
  mandate_id TEXT PRIMARY KEY,
  mandate_version INTEGER NOT NULL,
  institution_id TEXT NOT NULL,
  status TEXT NOT NULL,
  mandate_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS governance_mandates_institution_status_idx
  ON governance_mandates (institution_id, status);

CREATE TABLE IF NOT EXISTS authority_delegations (
  delegation_id TEXT PRIMARY KEY,
  delegation_version INTEGER NOT NULL,
  delegator_principal_id TEXT NOT NULL,
  delegate_principal_id TEXT NOT NULL,
  authority_role TEXT NOT NULL,
  status TEXT NOT NULL,
  delegation_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS authority_delegations_delegate_idx
  ON authority_delegations (delegate_principal_id, status);
CREATE INDEX IF NOT EXISTS authority_delegations_delegator_idx
  ON authority_delegations (delegator_principal_id, status);

CREATE TABLE IF NOT EXISTS governance_direct_grants (
  grant_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  authority_role TEXT NOT NULL,
  institution_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS governance_direct_grants_principal_idx
  ON governance_direct_grants (principal_id, status);

CREATE TABLE IF NOT EXISTS governance_cases (
  governance_case_id TEXT PRIMARY KEY,
  case_version INTEGER NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL,
  case_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS governance_cases_subject_idx
  ON governance_cases (subject_id, status);

CREATE TABLE IF NOT EXISTS governance_attestations (
  attestation_id TEXT PRIMARY KEY,
  governance_case_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  authority_role TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  attestation_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS governance_attestations_logical_uq
  ON governance_attestations (logical_key);
CREATE INDEX IF NOT EXISTS governance_attestations_case_idx
  ON governance_attestations (governance_case_id);

CREATE TABLE IF NOT EXISTS institutional_authorization_proofs (
  institutional_authorization_proof_id TEXT PRIMARY KEY,
  governance_case_id TEXT NOT NULL,
  proof_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS institutional_authorization_proofs_case_uq
  ON institutional_authorization_proofs (governance_case_id);

CREATE TABLE IF NOT EXISTS authority_revocations (
  revocation_id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  revocation_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS authority_revocations_target_idx
  ON authority_revocations (target_type, target_id);

CREATE TABLE IF NOT EXISTS governance_holds (
  hold_id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  status TEXT NOT NULL,
  hold_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS governance_holds_institution_status_idx
  ON governance_holds (institution_id, status);

CREATE TABLE IF NOT EXISTS institutional_authority_snapshots (
  authority_snapshot_id TEXT PRIMARY KEY,
  snapshot_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS governance_audit_events (
  audit_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  institution_id TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS governance_audit_events_institution_idx
  ON governance_audit_events (institution_id, created_at);

-- Extend authority_grants principal_type for Phase 20 institutional roles.
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
    'SECURITY_REVIEWER'
  ));
