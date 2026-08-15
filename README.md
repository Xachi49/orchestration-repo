# Orchestrator Agent

Evidence-grounded, policy-governed orchestration: contracts, control plane, admission, verified repository truth, and bounded planning.

**Package name:** `orchestrator-agent`  
**Repository folder / remote:** `orchestration-repo`

> AI may determine what could be useful. Deterministic systems determine what is true, permitted, affordable, authorized, executable, successful, and worthy of being remembered.

## Current milestone: Phase 4 — Context compilation & planning

Phase 4 compiles verified repository truth into a bounded planning context and produces a `READY_FOR_VALIDATION` candidate `ExecutionPlan`. The planning model may only propose. It does not approve, execute, write to GitHub, or grant capabilities.

See [docs/architecture.md](docs/architecture.md).

## Phase 3 — Verified repository truth

Immutable commit-SHA lock, detached workspace, fingerprint, deterministic index, evidence registry, drift detection, ingestion fencing.

## Phase 2 — Objective admission

`RECEIVED → ADMITTED` with requester authorization, idempotency, and admission fencing. Objectives are persisted for later planning.

## Phase 1 — Deterministic Control Plane

Project, capability, policy, and budget registries. Configuration authority only.

## Phase 0

Domain contracts, run-state machine, plan hashing, evidence records.

## What remains unimplemented

- Independent validator LLM / Phase 5 REVISE loops
- Human approval (Discord/Slack)
- Execution, patches, shell, GitHub writes
- Embeddings / vector memory
- Production databases

Default `npm start` / `npm test` use `FakePlanningModel` (no paid API calls).

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
```

## Auth / live model

- `GITHUB_TOKEN` — optional read-only GitHub REST
- `OPENAI_API_KEY` / `OPENAI_MODEL` — optional live planning via Responses API; never committed
