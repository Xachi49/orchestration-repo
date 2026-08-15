# Orchestrator Agent

Evidence-grounded, policy-governed orchestration: contracts, control plane, admission, verified repository truth, bounded planning, independent validation, human authorization, and bounded execution.

**Package name:** `orchestrator-agent`  
**Repository folder / remote:** `orchestration-repo`

> AI may determine what could be useful. Deterministic systems determine what is true, permitted, affordable, authorized, executable, successful, and worthy of being remembered.

## Current milestone: Phase 7 — Bounded execution & safe actuation

Phase 7 executes only an exact, human-authorized, still-fresh plan through a narrow capability surface.

- `APPROVED != EXECUTED`. Authorization alone does not actuate.
- `EXECUTION_SUCCEEDED != VERIFIED_SUCCESS`. Actuator completion is not Phase 8 verification.
- Only `APPROVED → EXECUTING` is owned here. The run stays `EXECUTING`; Phase 7 does not `COMPLETE`.
- `VALIDATING` / `AWAITING_APPROVAL` cannot execute.
- Allowed actions only: `CREATE_LOCAL_PATCH`, `RUN_TESTS`, `CREATE_TASK`, `PREPARE_PULL_REQUEST`.
- No arbitrary shell, GitHub writes, Discord/Slack, or LLM calls in execution.
- Default stack uses `FakeSafeActuator`. Use `createExecutionFriendlyPlanningModel()` in tests (default `FakePlanningModel` emits `READ_FILE`, which dry-run rejects).

See [docs/architecture.md](docs/architecture.md).

## Phase 6 — Human authorization & exception inbox

Exact-plan approval binding. `PASS != APPROVED`. `AWAITING_APPROVAL → APPROVED` only.

## Phase 5 — Independent validation

`PASS` / `BLOCK` / `HUMAN_APPROVAL_REQUIRED` / `REVISE`. Run stays `VALIDATING`.

## Phase 4 — Context compilation & planning

Bounded planning context and a `READY_FOR_VALIDATION` candidate plan.

## Phase 3 — Verified repository truth

Immutable commit-SHA lock, fingerprint, evidence registry, drift detection.

## Phase 2 — Objective admission

`RECEIVED → ADMITTED` with requester authorization and fencing.

## Phase 1 — Deterministic Control Plane

Project, capability, policy, and budget registries. Configuration authority only.

## Phase 0

Domain contracts, run-state machine, plan hashing, evidence records.

## What remains unimplemented

- Discord/Slack vendor delivery (port + fake only)
- Phase 8 verification / learning
- GitHub writes, arbitrary shell, deployments
- Embeddings / vector memory
- Production databases

Default `npm start` / `npm test` use fake planning/validation models, fake approval delivery, and fake actuators (no paid API calls).

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
POST /v1/runs/:runId/authorization-route
GET  /v1/runs/:runId/approval-request
GET  /v1/runs/:runId/authorization-readiness
POST /v1/approval-requests/:approvalRequestId/decision
GET  /v1/runs/:runId/authorization
POST /v1/approval-requests/expire
POST /v1/runs/:runId/execute
GET  /v1/runs/:runId/execution
GET  /v1/runs/:runId/execution-artifacts
```

## Auth / live model

- `GITHUB_TOKEN` — optional read-only GitHub REST
- `OPENAI_API_KEY` / `OPENAI_MODEL` — optional live planning via Responses API; never committed
- `OPENAI_VALIDATION_MODEL` — optional separate model id for live validation; the default stack never constructs the live adapter
