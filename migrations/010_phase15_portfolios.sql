-- Phase 15: governed portfolios, plans, budget escrow, lineage, authorization, completion, rebalance.

CREATE TABLE IF NOT EXISTS portfolios (
  portfolio_id TEXT PRIMARY KEY,
  primary_project_id TEXT NOT NULL,
  portfolio_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS portfolios_idempotency_uq
  ON portfolios (idempotency_key);
CREATE INDEX IF NOT EXISTS portfolios_primary_project_idx
  ON portfolios (primary_project_id);
CREATE INDEX IF NOT EXISTS portfolios_status_updated_idx
  ON portfolios (status, updated_at ASC, portfolio_id ASC);

CREATE TABLE IF NOT EXISTS portfolio_plans (
  portfolio_id TEXT NOT NULL,
  portfolio_plan_version INTEGER NOT NULL,
  portfolio_plan_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (portfolio_id, portfolio_plan_version)
);

CREATE TABLE IF NOT EXISTS portfolio_budget_ledgers (
  portfolio_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_budget_reservations (
  reservation_id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS portfolio_budget_reservations_proposal_uq
  ON portfolio_budget_reservations (portfolio_id, proposal_id);

CREATE TABLE IF NOT EXISTS portfolio_program_lineage (
  lineage_id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL,
  portfolio_plan_version INTEGER NOT NULL,
  proposal_id TEXT NOT NULL,
  program_id TEXT,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS portfolio_program_lineage_portfolio_plan_idx
  ON portfolio_program_lineage (portfolio_id, portfolio_plan_version);

CREATE TABLE IF NOT EXISTS portfolio_authorization_requests (
  authorization_id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS portfolio_authorization_requests_portfolio_status_idx
  ON portfolio_authorization_requests (portfolio_id, status);

CREATE TABLE IF NOT EXISTS portfolio_authorization_records (
  authorization_record_id TEXT PRIMARY KEY,
  authorization_id TEXT NOT NULL,
  portfolio_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS portfolio_authorization_records_portfolio_idx
  ON portfolio_authorization_records (portfolio_id, created_at DESC);

CREATE TABLE IF NOT EXISTS portfolio_completion_records (
  portfolio_completion_record_id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_rebalance_records (
  rebalance_id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS portfolio_rebalance_records_portfolio_idx
  ON portfolio_rebalance_records (portfolio_id, created_at ASC);

-- Expand scheduler work_kind check for Portfolio progression (Phase 13 claim/fence).
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
    'REBALANCE_PORTFOLIO'
  ));

-- Portfolio allocator role is distinct from Phase 6 execution approver and program materializer.
ALTER TABLE authority_grants DROP CONSTRAINT IF EXISTS authority_grants_principal_type_check;
ALTER TABLE authority_grants ADD CONSTRAINT authority_grants_principal_type_check
  CHECK (principal_type IN ('REQUESTER', 'APPROVER', 'PROGRAM_MATERIALIZER', 'PORTFOLIO_ALLOCATOR'));
