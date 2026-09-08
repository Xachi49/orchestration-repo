-- Phase 22: governed federation — agreements, ratifications, activation,
-- work intents/acceptances/materializations, evidence envelopes, audit.

CREATE TABLE IF NOT EXISTS federation_agreements (
  agreement_id TEXT PRIMARY KEY,
  federation_id TEXT NOT NULL,
  agreement_version INTEGER NOT NULL,
  agreement_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS federation_agreements_fed_version_uq
  ON federation_agreements (federation_id, agreement_version);
CREATE INDEX IF NOT EXISTS federation_agreements_federation_status_idx
  ON federation_agreements (federation_id, status);

CREATE TABLE IF NOT EXISTS federation_ratifications (
  ratification_id TEXT PRIMARY KEY,
  federation_id TEXT NOT NULL,
  agreement_id TEXT NOT NULL,
  institution_id TEXT NOT NULL,
  ratification_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS federation_ratifications_agreement_inst_uq
  ON federation_ratifications (agreement_id, institution_id);
CREATE INDEX IF NOT EXISTS federation_ratifications_agreement_idx
  ON federation_ratifications (agreement_id);

CREATE TABLE IF NOT EXISTS federation_activation_records (
  activation_record_id TEXT PRIMARY KEY,
  federation_id TEXT NOT NULL,
  agreement_id TEXT NOT NULL,
  activation_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS federation_activation_records_agreement_uq
  ON federation_activation_records (agreement_id);

CREATE TABLE IF NOT EXISTS federation_participation_changes (
  change_id TEXT PRIMARY KEY,
  federation_id TEXT NOT NULL,
  agreement_id TEXT NOT NULL,
  institution_id TEXT NOT NULL,
  change_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS federation_participation_changes_agreement_idx
  ON federation_participation_changes (agreement_id);

CREATE TABLE IF NOT EXISTS federated_work_intents (
  intent_id TEXT PRIMARY KEY,
  federation_id TEXT NOT NULL,
  agreement_id TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS federated_work_intents_agreement_idx
  ON federated_work_intents (agreement_id);

CREATE TABLE IF NOT EXISTS federated_work_acceptances (
  acceptance_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  acceptance_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS federated_work_acceptances_intent_uq
  ON federated_work_acceptances (intent_id);

CREATE TABLE IF NOT EXISTS federated_materializations (
  materialization_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  materialization_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS federated_materializations_intent_uq
  ON federated_materializations (intent_id);
CREATE UNIQUE INDEX IF NOT EXISTS federated_materializations_idempotency_uq
  ON federated_materializations (idempotency_key);

CREATE TABLE IF NOT EXISTS federated_evidence_envelopes (
  envelope_id TEXT PRIMARY KEY,
  federation_id TEXT NOT NULL,
  agreement_id TEXT NOT NULL,
  envelope_hash TEXT NOT NULL,
  destination_institution_id TEXT NOT NULL,
  destination_project_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS federated_evidence_envelopes_dest_idx
  ON federated_evidence_envelopes (destination_institution_id, destination_project_id);

CREATE TABLE IF NOT EXISTS federation_audit_events (
  audit_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  federation_id TEXT NOT NULL,
  agreement_id TEXT,
  intent_id TEXT,
  institution_id TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS federation_audit_events_federation_idx
  ON federation_audit_events (federation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS federation_audit_events_agreement_idx
  ON federation_audit_events (agreement_id, created_at ASC);

-- Extend authority_grants principal_type for Phase 22 federation roles.
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
    'FEDERATION_EVIDENCE_SHARER'
  ));
