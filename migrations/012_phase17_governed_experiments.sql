-- Phase 17: governed experiments, plans, sponsor authorization, execution lineage,
-- results, evidence bundles, completion, assumption update candidates, usage.

CREATE TABLE IF NOT EXISTS governed_experiments (
  experiment_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  experiment_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS governed_experiments_idempotency_uq
  ON governed_experiments (idempotency_key);
CREATE INDEX IF NOT EXISTS governed_experiments_project_idx
  ON governed_experiments (project_id);
CREATE INDEX IF NOT EXISTS governed_experiments_status_updated_idx
  ON governed_experiments (status, updated_at ASC, experiment_id ASC);

CREATE TABLE IF NOT EXISTS experiment_plans (
  experiment_id TEXT NOT NULL,
  experiment_plan_version INTEGER NOT NULL,
  experiment_plan_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (experiment_id, experiment_plan_version)
);

CREATE INDEX IF NOT EXISTS experiment_plans_experiment_version_idx
  ON experiment_plans (experiment_id, experiment_plan_version DESC);
CREATE UNIQUE INDEX IF NOT EXISTS experiment_plans_hash_uq
  ON experiment_plans (experiment_id, experiment_plan_hash);

CREATE TABLE IF NOT EXISTS experiment_authorization_requests (
  authorization_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS experiment_authorization_requests_experiment_status_idx
  ON experiment_authorization_requests (experiment_id, status);

CREATE TABLE IF NOT EXISTS experiment_authorization_records (
  authorization_record_id TEXT PRIMARY KEY,
  authorization_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS experiment_authorization_records_experiment_idx
  ON experiment_authorization_records (experiment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS experiment_execution_lineage (
  lineage_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  experiment_plan_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS experiment_execution_lineage_experiment_idx
  ON experiment_execution_lineage (experiment_id);

CREATE TABLE IF NOT EXISTS experiment_results (
  experiment_result_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  experiment_plan_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS experiment_results_experiment_idx
  ON experiment_results (experiment_id);

CREATE TABLE IF NOT EXISTS experiment_evidence_bundles (
  evidence_bundle_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  evidence_bundle_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS experiment_evidence_bundles_experiment_uq
  ON experiment_evidence_bundles (experiment_id);
CREATE UNIQUE INDEX IF NOT EXISTS experiment_evidence_bundles_hash_uq
  ON experiment_evidence_bundles (evidence_bundle_hash);

CREATE TABLE IF NOT EXISTS experiment_completion_records (
  completion_record_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  evidence_bundle_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS experiment_completion_records_experiment_uq
  ON experiment_completion_records (experiment_id);

CREATE TABLE IF NOT EXISTS assumption_evidence_update_candidates (
  candidate_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  assumption_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS assumption_evidence_update_candidates_experiment_idx
  ON assumption_evidence_update_candidates (experiment_id);

CREATE TABLE IF NOT EXISTS experiment_usage_ledgers (
  experiment_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE scheduler_work_items DROP CONSTRAINT IF EXISTS scheduler_work_items_work_kind_check;
ALTER TABLE scheduler_work_items ADD CONSTRAINT scheduler_work_items_work_kind_check
  CHECK (work_kind IN (
    'INGEST_REPOSITORY',
    'PLAN_RUN',
    'VALIDATE_PLAN',
    'ROUTE_AUTHORIZATION',
    'EXECUTE_PLAN',
    'VERIFY_OUTCOME',
    'LEARN_FROM_RUN',
    'BUILD_OBSERVABILITY',
    'DECOMPOSE_PROGRAM',
    'VALIDATE_PROGRAM',
    'ROUTE_PROGRAM_MATERIALIZATION',
    'MATERIALIZE_PROGRAM',
    'RECONCILE_PROGRAM',
    'VERIFY_PROGRAM',
    'ANALYZE_PORTFOLIO',
    'PLAN_PORTFOLIO',
    'VALIDATE_PORTFOLIO',
    'ROUTE_PORTFOLIO_AUTHORIZATION',
    'MATERIALIZE_PORTFOLIO_PROGRAMS',
    'RECONCILE_PORTFOLIO',
    'VERIFY_PORTFOLIO',
    'REBALANCE_PORTFOLIO',
    'GROUND_DECISION_PROBLEM',
    'GENERATE_SCENARIOS',
    'SIMULATE_SCENARIOS',
    'ANALYZE_SCENARIOS',
    'VALIDATE_DECISION_PACKAGE',
    'ROUTE_STRATEGY_SELECTION',
    'MATERIALIZE_PORTFOLIO_PROPOSAL',
    'DESIGN_EXPERIMENT',
    'VALIDATE_EXPERIMENT',
    'ROUTE_EXPERIMENT_AUTHORIZATION',
    'COMPILE_EXPERIMENT_EXECUTION',
    'RECONCILE_EXPERIMENT',
    'VERIFY_EXPERIMENT',
    'BUILD_EVIDENCE_BUNDLE',
    'PROPOSE_ASSUMPTION_UPDATE'
  ));

ALTER TABLE authority_grants DROP CONSTRAINT IF EXISTS authority_grants_principal_type_check;
ALTER TABLE authority_grants ADD CONSTRAINT authority_grants_principal_type_check
  CHECK (principal_type IN (
    'REQUESTER',
    'APPROVER',
    'PROGRAM_MATERIALIZER',
    'PORTFOLIO_ALLOCATOR',
    'STRATEGY_SELECTOR',
    'EXPERIMENT_SPONSOR'
  ));
