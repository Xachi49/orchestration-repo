-- Phase 16: strategic decision problems, scenario sets, simulation, packages,
-- strategy selection, portfolio lineage, calibration, usage ledgers.

CREATE TABLE IF NOT EXISTS strategic_decision_problems (
  decision_problem_id TEXT PRIMARY KEY,
  primary_project_id TEXT NOT NULL,
  decision_problem_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS strategic_decision_problems_idempotency_uq
  ON strategic_decision_problems (idempotency_key);
CREATE INDEX IF NOT EXISTS strategic_decision_problems_primary_project_idx
  ON strategic_decision_problems (primary_project_id);
CREATE INDEX IF NOT EXISTS strategic_decision_problems_status_updated_idx
  ON strategic_decision_problems (status, updated_at ASC, decision_problem_id ASC);

CREATE TABLE IF NOT EXISTS scenario_sets (
  decision_problem_id TEXT NOT NULL,
  scenario_set_version INTEGER NOT NULL,
  scenario_set_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (decision_problem_id, scenario_set_version)
);

CREATE INDEX IF NOT EXISTS scenario_sets_decision_problem_version_idx
  ON scenario_sets (decision_problem_id, scenario_set_version DESC);

CREATE TABLE IF NOT EXISTS scenario_simulation_results (
  simulation_run_id TEXT PRIMARY KEY,
  decision_problem_id TEXT NOT NULL,
  scenario_set_id TEXT NOT NULL,
  scenario_set_version INTEGER NOT NULL,
  input_fingerprint TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS scenario_simulation_results_input_fingerprint_uq
  ON scenario_simulation_results (input_fingerprint);
CREATE INDEX IF NOT EXISTS scenario_simulation_results_scenario_set_idx
  ON scenario_simulation_results (scenario_set_id, scenario_set_version);

CREATE TABLE IF NOT EXISTS strategic_decision_packages (
  decision_problem_id TEXT NOT NULL,
  decision_package_version INTEGER NOT NULL,
  decision_package_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (decision_problem_id, decision_package_version)
);

CREATE INDEX IF NOT EXISTS strategic_decision_packages_decision_problem_version_idx
  ON strategic_decision_packages (decision_problem_id, decision_package_version DESC);

CREATE TABLE IF NOT EXISTS strategy_selection_requests (
  selection_id TEXT PRIMARY KEY,
  decision_problem_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS strategy_selection_requests_decision_status_idx
  ON strategy_selection_requests (decision_problem_id, status);

CREATE TABLE IF NOT EXISTS strategy_selection_records (
  selection_record_id TEXT PRIMARY KEY,
  selection_id TEXT NOT NULL,
  decision_problem_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS strategy_selection_records_decision_problem_idx
  ON strategy_selection_records (decision_problem_id, created_at DESC);

CREATE TABLE IF NOT EXISTS scenario_portfolio_lineage (
  lineage_id TEXT PRIMARY KEY,
  decision_problem_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS scenario_portfolio_lineage_decision_problem_idx
  ON scenario_portfolio_lineage (decision_problem_id);

CREATE TABLE IF NOT EXISTS scenario_calibration_records (
  calibration_id TEXT PRIMARY KEY,
  decision_problem_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS scenario_calibration_records_decision_problem_idx
  ON scenario_calibration_records (decision_problem_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS simulation_usage_ledgers (
  decision_problem_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL
);

-- Expand scheduler work_kind check for Scenario progression (Phase 13 claim/fence).
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
    'MATERIALIZE_PORTFOLIO_PROPOSAL'
  ));

-- Strategy selector role is distinct from approver, allocator, and materializer.
ALTER TABLE authority_grants DROP CONSTRAINT IF EXISTS authority_grants_principal_type_check;
ALTER TABLE authority_grants ADD CONSTRAINT authority_grants_principal_type_check
  CHECK (principal_type IN (
    'REQUESTER',
    'APPROVER',
    'PROGRAM_MATERIALIZER',
    'PORTFOLIO_ALLOCATOR',
    'STRATEGY_SELECTOR'
  ));
