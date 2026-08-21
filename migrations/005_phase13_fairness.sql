-- Phase 13 closure: durable cross-runtime scheduler fairness state.
-- Operational coordination only — not business authority.

CREATE TABLE IF NOT EXISTS scheduler_fairness_state (
  project_id TEXT PRIMARY KEY,
  deficit INTEGER NOT NULL DEFAULT 0 CHECK (deficit >= 0),
  last_served_at TIMESTAMPTZ,
  service_sequence BIGINT NOT NULL DEFAULT 0 CHECK (service_sequence >= 0),
  record_revision BIGINT NOT NULL DEFAULT 1 CHECK (record_revision >= 1),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Singleton row used with FOR UPDATE to serialize fairness charge transactions.
CREATE TABLE IF NOT EXISTS scheduler_fairness_lock (
  lock_id TEXT PRIMARY KEY CHECK (lock_id = 'global'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO scheduler_fairness_lock (lock_id)
VALUES ('global')
ON CONFLICT (lock_id) DO NOTHING;
