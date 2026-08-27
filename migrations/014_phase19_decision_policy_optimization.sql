-- Phase 19: decision contexts, policy candidates, evaluations, comparisons,
-- approval/activation, shadow records, snapshots, recommendations, performance.

CREATE TABLE IF NOT EXISTS decision_contexts (
  decision_context_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_policy_candidates (
  decision_policy_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS decision_policy_candidates_status_updated_idx
  ON decision_policy_candidates (status, updated_at ASC, decision_policy_id ASC);

CREATE TABLE IF NOT EXISTS decision_policy_evaluations (
  decision_policy_evaluation_id TEXT PRIMARY KEY,
  decision_policy_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS decision_policy_evaluations_policy_idx
  ON decision_policy_evaluations (decision_policy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_policy_comparisons (
  decision_policy_comparison_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_policy_approval_requests (
  decision_policy_approval_request_id TEXT PRIMARY KEY,
  decision_policy_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS decision_policy_approval_requests_policy_status_idx
  ON decision_policy_approval_requests (decision_policy_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS decision_policy_approval_records (
  decision_policy_approval_record_id TEXT PRIMARY KEY,
  decision_policy_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS decision_policy_approval_records_policy_idx
  ON decision_policy_approval_records (decision_policy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_policy_shadow_records (
  shadow_decision_record_id TEXT PRIMARY KEY,
  decision_policy_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS decision_policy_shadow_records_policy_idx
  ON decision_policy_shadow_records (decision_policy_id, created_at ASC);

CREATE TABLE IF NOT EXISTS decision_policy_shadow_evaluations (
  decision_policy_shadow_evaluation_id TEXT PRIMARY KEY,
  decision_policy_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS decision_policy_shadow_evaluations_policy_idx
  ON decision_policy_shadow_evaluations (decision_policy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_policy_activation_requests (
  decision_policy_activation_request_id TEXT PRIMARY KEY,
  decision_policy_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS decision_policy_activation_requests_policy_status_idx
  ON decision_policy_activation_requests (decision_policy_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS decision_policy_activation_records (
  decision_policy_activation_id TEXT PRIMARY KEY,
  decision_policy_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS decision_policy_activation_records_policy_idx
  ON decision_policy_activation_records (decision_policy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_state_snapshots (
  decision_state_snapshot_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS decision_state_snapshots_hash_uq
  ON decision_state_snapshots ((payload->>'snapshotHash'));

CREATE TABLE IF NOT EXISTS decision_recommendations (
  decision_recommendation_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS decision_recommendations_hash_uq
  ON decision_recommendations ((payload->>'recommendationHash'));

CREATE TABLE IF NOT EXISTS decision_override_records (
  decision_override_record_id TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS decision_override_records_recommendation_idx
  ON decision_override_records (recommendation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS decision_policy_performance_records (
  decision_policy_performance_record_id TEXT PRIMARY KEY,
  decision_policy_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS decision_policy_performance_records_policy_idx
  ON decision_policy_performance_records (decision_policy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_policy_revision_candidates (
  decision_policy_revision_candidate_id TEXT PRIMARY KEY,
  source_policy_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS decision_policy_revision_candidates_source_idx
  ON decision_policy_revision_candidates (source_policy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_policy_usage_ledgers (
  decision_policy_id TEXT PRIMARY KEY,
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
    'PROPOSE_ASSUMPTION_UPDATE',
    'PROPOSE_CAUSAL_GRAPH',
    'ANALYZE_IDENTIFICATION',
    'ESTIMATE_CAUSAL_EFFECT',
    'SYNTHESIZE_CAUSAL_EVIDENCE',
    'VALIDATE_CAUSAL_CLAIM',
    'ROUTE_CAUSAL_REVIEW',
    'PROMOTE_CAUSAL_CLAIM',
    'PROPOSE_MODEL_CALIBRATION',
    'SYNTHESIZE_DECISION_POLICY',
    'VALIDATE_DECISION_POLICY',
    'EVALUATE_DECISION_POLICY',
    'ROUTE_POLICY_APPROVAL',
    'RUN_POLICY_SHADOW',
    'EVALUATE_POLICY_SHADOW',
    'ROUTE_POLICY_ACTIVATION',
    'GENERATE_DECISION_RECOMMENDATION',
    'PROPOSE_POLICY_REVISION'
  ));

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
    'DECISION_POLICY_ACTIVATOR'
  ));
