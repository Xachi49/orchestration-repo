# Orchestrator Agent

Evidence-grounded, policy-governed orchestration contracts, run-state architecture, deterministic control plane, and objective admission.

**Package name:** `orchestrator-agent`  
**Repository folder / remote:** `orchestration-repo`

> AI may determine what could be useful. Deterministic systems determine what is true, permitted, affordable, authorized, executable, successful, and worthy of being remembered.

## Current milestone: Phase 2 — Objective admission

Phase 2 is the front door of the Orchestrator. It turns an incoming project objective into a validated, authorized, deduplicated, conflict-aware, durable run in `ADMITTED`.

See [docs/architecture.md](docs/architecture.md).

Phase 2 establishes admission authority and durable run identity.
It does not establish repository truth, planning intelligence, human approval, or execution authority.

## Phase 1 — Deterministic Control Plane

- Project, capability, policy-bundle, and resource-budget registries
- Fail-closed `ControlPlaneService` that assembles `ProjectControlContext`
- In-memory adapters for tests and local development
- Example fixtures for `discord-scale-architect` (no real external authority)

The Control Plane defines what may eventually be permissible. It does **not** execute anything.

## Phase 0 (still in place)

- Strongly typed domain contracts (Zod + TypeScript) for Objective, Event Envelope, Evidence, Execution Plan/Step, and Validation Decision
- Deterministic run-state machine with explicit transitions (fail closed)
- Objective idempotency key from `projectId + objectiveId + objectiveVersion + requestedEnvironment`
- Canonical `objectiveFingerprint` for content conflict detection
- Canonical plan serialization and `PlanHasher` (SHA-256)
- Architectural boundary ports for planner / validator / approver / executor / memory

## What is intentionally unimplemented

- LLM / OpenAI / Anthropic connections
- GitHub (or other SCM) API integrations
- Real plan generation, ingestion, approval workflows
- Execution, rollback, containment behavior
- Discord / Slack / n8n / autonomous tool access
- Distributed locks / production databases
- Policy evaluation engine / OPA
- Secret management or credential storage
- Shell / command execution abstractions with active implementations

## Architecture

```text
src/
├── api/                 # Health + POST /v1/runs (no business logic)
├── domain/              # Typed contracts + deterministic helpers
├── control-plane/       # Configuration authority
├── admission/           # Admission service and ports
├── ingestion/
├── planning/
├── validation/
├── approval/
├── execution/
├── verification/
├── memory/
├── observability/
└── infrastructure/      # In-memory adapters
```

## Commands

```bash
npm install
npm run typecheck
npm test
npm run build
```

```bash
npm start
# GET  http://127.0.0.1:3000/health
# POST http://127.0.0.1:3000/v1/runs
```

`POST /v1/runs` status mapping:

- `ADMITTED` → 201
- `COMPLETED_DUPLICATE` → 200
- `ACTIVE_DUPLICATE` → 409
- invalid request → 400
- unauthorized / unknown requester → 403
- project not found → 404
- conflict / ineligible → 409

## Security posture

- No `eval`
- No dynamic execution of retrieved or stored configuration
- No hardcoded secrets
- Unknown requester and missing authority are denial
- Duplicate idempotency keys do not create a second run
- Failed lock lookup is never treated as an acquired lock
- Dangerous operations remain behind disconnected / disabled ports
