# Orchestrator Agent

Evidence-grounded, policy-governed orchestration: contracts, control plane, admission, verified repository truth, bounded planning, independent validation, human authorization, bounded execution, and independent outcome verification.

**Package name:** `orchestrator-agent`  
**Repository folder / remote:** `orchestration-repo`

> AI may determine what could be useful. Deterministic systems determine what is true, permitted, affordable, authorized, executable, successful, and worthy of being remembered.

## Current milestone: Phase 8 — Independent outcome verification

Phase 8 independently determines whether post-execution reality satisfies the authorized objective.

- `EXECUTION_SUCCEEDED != VERIFIED_SUCCESS`. Actuator completion is not verified objective success.
- `VERIFIED_SUCCESS != "the model thinks it worked"`. Contextual model may only downgrade.
- `COMPLETED` requires evidence-backed `VERIFIED_SUCCESS` plus a `CompletionRecord`.
- Acceptance criteria use **explicit plan-bound verification bindings** (hashed into `planHash`). `HEURISTIC_RELEVANCE ≠ VERIFICATION_BINDING`.
- Path: `EXECUTING → VERIFYING → COMPLETED` (or `ESCALATED` / preserve `CONTAINED`).
- `EXECUTING → COMPLETED` is illegal. The executor cannot verify itself.
- Default stack uses `FakeVerificationModel`. No live APIs in tests.

See [docs/architecture.md](docs/architecture.md).

## Phase 7 — Bounded execution & safe actuation

Exact authorized plan through a narrow SafeActuator. Success leaves the run `EXECUTING`.

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
- Phase 9 learning / memory promotion
- GitHub writes, arbitrary shell, deployments
- Embeddings / vector memory
- Production databases
- Optional OpenAI verification adapter (FakeVerificationModel is default)

Default `npm start` / `npm test` use fake planning/validation/verification models, fake approval delivery, and fake actuators (no paid API calls).

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
POST /v1/runs/:runId/verify
GET  /v1/runs/:runId/verification
GET  /v1/runs/:runId/verification-evidence
```

## Auth / live model

- `GITHUB_TOKEN` — optional read-only GitHub REST
- `OPENAI_API_KEY` / `OPENAI_MODEL` — optional live planning via Responses API; never committed
- `OPENAI_VALIDATION_MODEL` — optional separate model id for live validation; the default stack never constructs the live adapter
