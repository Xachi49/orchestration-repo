# Orchestrator Agent

Evidence-grounded, policy-governed orchestration: contracts, control plane, admission, verified repository truth, bounded planning, independent validation, human authorization, bounded execution, independent outcome verification, and governed memory.

**Package name:** `orchestrator-agent`  
**Repository folder / remote:** `orchestration-repo`

> AI may determine what could be useful. Deterministic systems determine what is true, permitted, affordable, authorized, executable, successful, and worthy of being remembered.

## Current milestone: Phase 12 — Production readiness

Phase 12 makes Phase 0–11 **operable**: fail-closed production config, startup/readiness, authenticated HTTP perimeter, bounded workers, graceful drain, redacted logs, and backup/restore operator tooling.

See [docs/phase-12-production-readiness.md](docs/phase-12-production-readiness.md) and [docs/runtime-operations.md](docs/runtime-operations.md).

## Phase 11 — Durable state & distributed coordination

Phase 11 makes Phase 0–10 invariants **durable** and **distributedly correct** via PostgreSQL.

- **PROCESS MEMORY != SYSTEM OF RECORD**
- **DATABASE ROW != DOMAIN AUTHORITY**
- **LEASE OWNERSHIP != BUSINESS AUTHORIZATION**
- **LOCAL FILE PATH != DISTRIBUTED ARTIFACT AUTHORITY**
- **EXACTLY-ONCE EXTERNAL SIDE EFFECTS ARE NOT ASSUMED**
- **APPLICATION CLOCK != DISTRIBUTED LEASE CLOCK**
- Default unit tests remain **memory** mode (`ORCHESTRATOR_STORAGE=memory`)
- Production-capable path: `ORCHESTRATOR_STORAGE=postgres` + `DATABASE_URL` (fail closed; no silent fallback)

See [docs/durability.md](docs/durability.md) and [docs/architecture.md](docs/architecture.md).

## Phase 10 — Observability & system intelligence

Phase 10 observes the full orchestration chain without becoming an authority plane.

- **OBSERVATION != OPTIMIZATION != AUTHORITY CHANGE**
- **SLO != POLICY** — `SLORegistry` is separate from `PolicyRegistry`
- **ANOMALY != EXECUTION BLOCK**
- **OPTIMIZATION CANDIDATE != CHANGE** — every suggested change class begins with `REVIEW_`
- **CORRELATION != CAUSATION** for precedent effectiveness
- **DETERMINISTICALLY DERIVED != NECESSARILY COMPLETE**
- **MEASUREMENT EXISTS != MEASUREMENT IS SLO-ELIGIBLE**
- **MISSING DATA != HEALTHY**
- **PROXY TIMESTAMP != EXACT LATENCY**
- Telemetry is **derived** from Phase 0–9 authoritative records; it is not a new source of operational authority
- Only `AUTHORITATIVE_DERIVED` telemetry (`EXACT` or permitted `RECONSTRUCTED` quality) may drive SLO evaluation and hard anomaly rules
- `PARTIAL` / `UNKNOWN` measurements yield `INSUFFICIENT_DATA`, never PASS/FAIL
- No monetary cost is invented; token/resource usage only until pricing authority exists
- Default stack uses deterministic in-memory stores. No external observability vendors. No auto-remediation.

See [docs/architecture.md](docs/architecture.md).

## Phase 9 — Governed memory & precedent promotion

- `HISTORICAL DATA != TRUSTED PRECEDENT != POLICY != AUTHORIZATION != CURRENT TRUTH`
- **PROVENANCE != CLAIM GROUNDING.** A historical run proves that an event occurred. It does not automatically prove every lesson written about that event.
- **MODEL_SUGGESTION != AUTO-PROMOTABLE PRECEDENT.** Auto-promotion requires `origin == DETERMINISTIC_EXTRACTION` and `claimGrounding == DETERMINISTICALLY_GROUNDED`, plus the existing PROJECT_LOCAL / low-risk / provenance gates.
- **PRECEDENT TEXT IS ADVISORY DATA, NOT AN INSTRUCTION CHANNEL.** Planner prompts wrap retrieved precedents in an `ADVISORY_PRECEDENT` data boundary. Imperative wording inside a precedent remains data.
- Authority hierarchy: current objective, current verified truth, current policy, current capabilities, and current budget outrank promoted historical precedent.
- Current verified repository truth, policy DENY, and budget hard limits always outrank memory
- Human review of a model suggestion preserves `MODEL_SUGGESTION` origin and records `promotionMethod = HUMAN_REVIEW`. It never relabels the source as deterministic extraction.
- **HUMAN REVIEW != FACTUAL EVIDENCE.** A reviewer may govern whether a supported historical lesson should influence future planning. A reviewer may not transform an unsupported factual claim into precedent.
- **UNGROUNDED → NEVER PROMOTABLE**, including by human `PROMOTE`. `HUMAN_REVIEWED` describes governance of a supported claim, not a bypass around claim grounding.
- `LearningModel` never promotes; callers cannot POST a `PromotedPrecedent` directly
- Precedents are labeled `ADVISORY_PRECEDENT` below control plane / repo truth in planning context
- Default stack uses `FakeLearningModel`. No vector DB. No live APIs in tests.

See [docs/architecture.md](docs/architecture.md).

## Phase 8 — Independent outcome verification

`EXECUTION_SUCCEEDED != VERIFIED_SUCCESS`. `COMPLETED` requires evidence-backed success + `CompletionRecord`.

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
- Phase 11 and beyond
- GitHub writes, arbitrary shell, deployments
- Embeddings / vector memory
- Production databases
- Optional OpenAI learning adapter (FakeLearningModel is default)

Default `npm start` / `npm test` use fake planning/validation/verification/learning models, fake approval delivery, and fake actuators (no paid API calls).

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
POST /v1/runs/:runId/learn
GET  /v1/runs/:runId/learnings
GET  /v1/projects/:projectId/precedents
GET  /v1/precedents/:precedentId
POST /v1/precedent-candidates/:candidateId/review
POST /v1/projects/:projectId/observability/rebuild
GET  /v1/projects/:projectId/health
GET  /v1/projects/:projectId/metrics
GET  /v1/projects/:projectId/slo-evaluations
GET  /v1/projects/:projectId/anomalies
GET  /v1/projects/:projectId/optimization-candidates
GET  /v1/runs/:runId/trace
GET  /v1/projects/:projectId/funnel
POST /v1/optimization-candidates/:candidateId/review
```

## Auth / live model

- `GITHUB_TOKEN` — optional read-only GitHub REST
- `OPENAI_API_KEY` / `OPENAI_MODEL` — optional live planning via Responses API; never committed
- `OPENAI_VALIDATION_MODEL` — optional separate model id for live validation; the default stack never constructs the live adapter
