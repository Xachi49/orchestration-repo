# Orchestrator Agent

Evidence-grounded, policy-governed orchestration: contracts, control plane, admission, verified repository truth, bounded planning, and independent validation.

**Package name:** `orchestrator-agent`  
**Repository folder / remote:** `orchestration-repo`

> AI may determine what could be useful. Deterministic systems determine what is true, permitted, affordable, authorized, executable, successful, and worthy of being remembered.

## Current milestone: Phase 5 — Independent validation

Phase 5 adjudicates a candidate plan and records a `ValidationDecision` of `PASS`, `BLOCK`, `HUMAN_APPROVAL_REQUIRED`, or `REVISE`. A deterministic validator ladder runs first (schema and hash recompute, plan state, freshness, policy, capability, dependency, resource, security). A separate validation model may then add advisory contextual observations; it cannot force a block, approve, or execute.

- `PASS` is not `APPROVED`. The run-state machine rejects `VALIDATING → APPROVED`. The run stays in `VALIDATING`; approval is Phase 6.
- Hard violations — policy `DENY`, hash mismatch, stale or invalid repository lock, rotated policy bundle, hard budget exceed — produce `BLOCK` with no revision.
- A repairable violation may trigger one bounded revision: `planVersion` 1 → 2 → 3 only. There is no v4.
- A repeated semantic fingerprint escalates to `HUMAN_APPROVAL_REQUIRED` with `REPEATED_SEMANTIC_VIOLATION`; exhausting the revision budget escalates with `REVISION_ATTEMPTS_EXHAUSTED`. Both raise a `PlanningException`.

See [docs/architecture.md](docs/architecture.md).

## Phase 4 — Context compilation & planning

Phase 4 compiles verified repository truth into a bounded planning context and produces a `READY_FOR_VALIDATION` candidate `ExecutionPlan`. The planning model may only propose. It does not approve, execute, write to GitHub, or grant capabilities.

## Phase 3 — Verified repository truth

Immutable commit-SHA lock, detached workspace, fingerprint, deterministic index, evidence registry, drift detection, ingestion fencing.

## Phase 2 — Objective admission

`RECEIVED → ADMITTED` with requester authorization, idempotency, and admission fencing. Objectives are persisted for later planning.

## Phase 1 — Deterministic Control Plane

Project, capability, policy, and budget registries. Configuration authority only.

## Phase 0

Domain contracts, run-state machine, plan hashing, evidence records.

## What remains unimplemented

- Human approval (Discord/Slack)
- Execution, patches, shell, GitHub writes
- Embeddings / vector memory
- Production databases

Default `npm start` / `npm test` use `FakePlanningModel` and `FakeValidationModel` (no paid API calls).

## Commands

```bash
npm install
npm run typecheck
npm test
npm run build
npm start
```

```text
POST /v1/runs
POST /v1/runs/:runId/ingest
GET  /v1/runs/:runId/repository-context
POST /v1/runs/:runId/plan
GET  /v1/runs/:runId/plan
GET  /v1/runs/:runId/planning-context
POST /v1/runs/:runId/validate
GET  /v1/runs/:runId/validation
GET  /v1/runs/:runId/validations
GET  /v1/runs/:runId/validation-readiness
```

## Auth / live model

- `GITHUB_TOKEN` — optional read-only GitHub REST
- `OPENAI_API_KEY` / `OPENAI_MODEL` — optional live planning via Responses API; never committed
- `OPENAI_VALIDATION_MODEL` — optional separate model id for live validation; the default stack never constructs the live adapter
