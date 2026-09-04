-- Phase 21: constitutional change control — proposals, impact analyses,
-- review decisions, activation records, audit events.

CREATE TABLE IF NOT EXISTS constitutional_change_proposals (
  constitutional_change_proposal_id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  proposal_version INTEGER NOT NULL,
  proposal_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS constitutional_change_proposals_institution_idx
  ON constitutional_change_proposals (institution_id, status);

CREATE TABLE IF NOT EXISTS constitutional_impact_analyses (
  impact_analysis_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  analysis_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS constitutional_impact_analyses_proposal_idx
  ON constitutional_impact_analyses (proposal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS constitutional_review_decisions (
  decision_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  decision_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS constitutional_review_decisions_proposal_idx
  ON constitutional_review_decisions (proposal_id, created_at ASC);

CREATE TABLE IF NOT EXISTS constitutional_activation_records (
  activation_record_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  activation_hash TEXT NOT NULL,
  idempotency_key TEXT,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS constitutional_activation_records_proposal_uq
  ON constitutional_activation_records (proposal_id);
CREATE UNIQUE INDEX IF NOT EXISTS constitutional_activation_records_idempotency_uq
  ON constitutional_activation_records (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS constitutional_audit_events (
  audit_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  institution_id TEXT NOT NULL,
  proposal_id TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS constitutional_audit_events_proposal_idx
  ON constitutional_audit_events (proposal_id, created_at ASC);

-- Extend authority_grants principal_type for Phase 21 constitutional roles.
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
    'CONSTITUTIONAL_ACTIVATOR'
  ));
