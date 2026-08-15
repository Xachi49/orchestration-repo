# Orchestrator Agent

Evidence-grounded, policy-governed orchestration: contracts, control plane, admission, verified repository truth, bounded planning, independent validation, and human authorization.

**Package name:** `orchestrator-agent`  
**Repository folder / remote:** `orchestration-repo`

> AI may determine what could be useful. Deterministic systems determine what is true, permitted, affordable, authorized, executable, successful, and worthy of being remembered.

## Current milestone: Phase 6 — Human authorization & exception inbox

Phase 6 consumes terminal Phase 5 `ValidationDecision` values and determines operational authorization before any future execution.

- `PASS != APPROVED`. PASS still creates an `ApprovalRequest` and routes `VALIDATING → AWAITING_APPROVAL`.
- `BLOCK` routes `VALIDATING → BLOCKED` with no approval request.
- `HUMAN_APPROVAL_REQUIRED` creates an approval request and decision card, then `AWAITING_APPROVAL`.
- Only Phase 6 may transition `AWAITING_APPROVAL → APPROVED` after an authorized human decision bound to the exact immutable plan.
- `APPROVED != EXECUTED`. Phase 6 does not execute, write to GitHub, or apply patches.
- Ordinary AI/model conversation is not a trusted authorization channel. Delivery uses a provider-neutral port (`FakeApprovalDeliveryService` locally).

See [docs/architecture.md](docs/architecture.md).

## Phase 5 — Independent validation

Phase 5 adjudicates a candidate plan (`PASS` / `BLOCK` / `HUMAN_APPROVAL_REQUIRED` / `REVISE`). The run stays `VALIDATING`. `VALIDATING → APPROVED` remains illegal.

## Phase 4 — Context compilation & planning

Bounded planning context and a `READY_FOR_VALIDATION` candidate plan. The planning model may only propose.

## Phase 3 — Verified repository truth

Immutable commit-SHA lock, fingerprint, evidence registry, drift detection.

## Phase 2 — Objective admission

`RECEIVED → ADMITTED` with requester authorization and fencing.

## Phase 1 — Deterministic Control Plane

Project, capability, policy, and budget registries. Configuration authority only.

## Phase 0

Domain contracts, run-state machine, plan hashing, evidence records.

## What remains unimplemented

- Discord/Slack vendor delivery (port + fake only in Phase 6)
- Execution, patches, shell, GitHub writes
- Embeddings / vector memory
- Production databases

Default `npm start` / `npm test` use fake planning/validation models and fake approval delivery (no paid API calls).

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
```

## Auth / live model

- `GITHUB_TOKEN` — optional read-only GitHub REST
- `OPENAI_API_KEY` / `OPENAI_MODEL` — optional live planning via Responses API; never committed
- `OPENAI_VALIDATION_MODEL` — optional separate model id for live validation; the default stack never constructs the live adapter
