-- Phase 18: causal questions, graphs, identification, estimates, evidence,
-- synthesis, claims, review, promotion, calibration candidates, usage.

CREATE TABLE IF NOT EXISTS causal_questions (
  causal_question_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS causal_questions_idempotency_uq
  ON causal_questions (idempotency_key);
CREATE INDEX IF NOT EXISTS causal_questions_status_updated_idx
  ON causal_questions (status, updated_at ASC, causal_question_id ASC);

CREATE TABLE IF NOT EXISTS causal_graphs (
  causal_graph_id TEXT NOT NULL,
  causal_graph_version INTEGER NOT NULL,
  causal_question_id TEXT NOT NULL,
  graph_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (causal_graph_id, causal_graph_version)
);

CREATE INDEX IF NOT EXISTS causal_graphs_question_version_idx
  ON causal_graphs (causal_question_id, causal_graph_version DESC);
CREATE UNIQUE INDEX IF NOT EXISTS causal_graphs_hash_uq
  ON causal_graphs (causal_question_id, graph_hash);

CREATE TABLE IF NOT EXISTS causal_identification_analyses (
  identification_analysis_id TEXT PRIMARY KEY,
  causal_question_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS causal_identification_analyses_question_idx
  ON causal_identification_analyses (causal_question_id, created_at DESC);

CREATE TABLE IF NOT EXISTS causal_estimates (
  causal_estimate_id TEXT PRIMARY KEY,
  causal_question_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS causal_estimates_question_idx
  ON causal_estimates (causal_question_id);

CREATE TABLE IF NOT EXISTS causal_evidence_references (
  evidence_ref_id TEXT PRIMARY KEY,
  causal_question_id TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS causal_evidence_references_question_idx
  ON causal_evidence_references (causal_question_id);

CREATE TABLE IF NOT EXISTS causal_evidence_syntheses (
  evidence_synthesis_id TEXT PRIMARY KEY,
  causal_question_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS causal_evidence_syntheses_question_idx
  ON causal_evidence_syntheses (causal_question_id, created_at DESC);

CREATE TABLE IF NOT EXISTS causal_claim_candidates (
  claim_id TEXT PRIMARY KEY,
  causal_question_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS causal_claim_candidates_question_idx
  ON causal_claim_candidates (causal_question_id, created_at DESC);

CREATE TABLE IF NOT EXISTS causal_review_requests (
  review_request_id TEXT PRIMARY KEY,
  causal_question_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS causal_review_requests_question_status_idx
  ON causal_review_requests (causal_question_id, status);

CREATE TABLE IF NOT EXISTS causal_review_records (
  review_record_id TEXT PRIMARY KEY,
  review_request_id TEXT NOT NULL,
  causal_question_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS causal_review_records_request_idx
  ON causal_review_records (review_request_id);
CREATE INDEX IF NOT EXISTS causal_review_records_question_idx
  ON causal_review_records (causal_question_id, created_at DESC);

CREATE TABLE IF NOT EXISTS promoted_causal_claims (
  promoted_causal_claim_id TEXT PRIMARY KEY,
  causal_question_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS promoted_causal_claims_question_idx
  ON promoted_causal_claims (causal_question_id);

CREATE TABLE IF NOT EXISTS causal_evidence_gaps (
  evidence_gap_id TEXT PRIMARY KEY,
  causal_question_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS causal_evidence_gaps_question_idx
  ON causal_evidence_gaps (causal_question_id);

CREATE TABLE IF NOT EXISTS decision_model_calibration_candidates (
  candidate_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS decision_model_calibration_candidates_payload_claims_idx
  ON decision_model_calibration_candidates
  USING GIN ((payload->'sourcePromotedCausalClaimIds'));

CREATE TABLE IF NOT EXISTS causal_usage_ledgers (
  causal_question_id TEXT PRIMARY KEY,
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
    'PROPOSE_MODEL_CALIBRATION'
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
    'CAUSAL_REVIEWER'
  ));
