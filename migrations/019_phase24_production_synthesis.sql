-- Phase 24: production synthesis, reference runtime & final system qualification.

CREATE TABLE IF NOT EXISTS production_qualification_runs (
  qualification_run_id TEXT PRIMARY KEY,
  release_candidate_fingerprint TEXT NOT NULL,
  runtime_manifest_hash TEXT NOT NULL,
  phase23_certificate_id TEXT NOT NULL,
  phase23_certificate_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  record_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS production_qualification_runs_candidate_idx
  ON production_qualification_runs (release_candidate_fingerprint);

CREATE TABLE IF NOT EXISTS qualification_evidence (
  evidence_id TEXT PRIMARY KEY,
  qualification_run_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS qualification_evidence_run_idx
  ON qualification_evidence (qualification_run_id);

CREATE TABLE IF NOT EXISTS release_qualification_records (
  record_id TEXT PRIMARY KEY,
  record_hash TEXT NOT NULL,
  material_fingerprint TEXT NOT NULL,
  release_candidate_fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS release_qualification_records_material_uq
  ON release_qualification_records (material_fingerprint);
CREATE INDEX IF NOT EXISTS release_qualification_records_candidate_idx
  ON release_qualification_records (release_candidate_fingerprint);

CREATE TABLE IF NOT EXISTS release_manifests (
  manifest_fingerprint TEXT PRIMARY KEY,
  release_candidate_fingerprint TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS release_manifests_candidate_idx
  ON release_manifests (release_candidate_fingerprint);

CREATE TABLE IF NOT EXISTS qualification_audit_events (
  audit_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  qualification_run_id TEXT,
  record_id TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS qualification_audit_events_run_idx
  ON qualification_audit_events (qualification_run_id);
