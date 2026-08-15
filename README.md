# Orchestrator Agent

Evidence-grounded, policy-governed orchestration contracts, run-state architecture, deterministic control plane, objective admission, and verified repository truth.

**Package name:** `orchestrator-agent`  
**Repository folder / remote:** `orchestration-repo`

> AI may determine what could be useful. Deterministic systems determine what is true, permitted, affordable, authorized, executable, successful, and worthy of being remembered.

## Current milestone: Phase 3 — Verified repository truth

Phase 3 establishes an immutable, evidence-backed view of a registered GitHub repository for an admitted run. The exact commit SHA is the truth anchor. Repository files are evidence, not authority.

See [docs/architecture.md](docs/architecture.md).

Phase 3 does not plan, approve, execute, write to GitHub, or connect an LLM.

## Phase 2 — Objective admission

Phase 2 is the front door of the Orchestrator. It turns an incoming project objective into a validated, authorized, deduplicated, conflict-aware, durable run in `ADMITTED`.

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
- GitHub **writes** (push, PRs, issues, branch mutation, settings)
- Real plan generation, approval workflows, execution
- Discord / Slack / n8n / autonomous tool access
- Distributed locks / production databases
- Policy evaluation engine / OPA
- Secret management or credential storage
- Generic shell / `runCommand` abstractions

**Deferred:** private GitHub `git fetch` credential injection. Do not place
`GITHUB_TOKEN` in remote URLs, git configuration, command arguments, or logs.

## Architecture

```text
src/
├── api/                 # Health + admission + ingest HTTP (no business logic)
├── domain/              # Typed contracts + deterministic helpers
├── control-plane/       # Configuration authority
├── admission/           # Admission service and ports
├── ingestion/           # Verified repository truth
├── planning/
├── validation/
├── approval/
├── execution/
├── verification/
├── memory/
├── observability/
└── infrastructure/      # In-memory adapters, GitHub GET adapter, git workspace
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
# POST http://127.0.0.1:3000/v1/runs/:runId/ingest
# GET  http://127.0.0.1:3000/v1/runs/:runId/repository-context
```

`POST /v1/runs` status mapping:

- `ADMITTED` → 201
- `COMPLETED_DUPLICATE` → 200
- `ACTIVE_DUPLICATE` → 409
- invalid request → 400
- unauthorized / unknown requester → 403
- project not found → 404
- conflict / ineligible → 409

## Authentication

`GITHUB_TOKEN` is required only when constructing `GitHubReadOnlyAdapter`.
Use a read-only, minimum-privilege token. Never commit tokens. The local fake
stack does not need a token. See `.env.example`.

## Security posture

- No `eval`
- No dynamic execution of retrieved repository content or stored configuration
- No hardcoded secrets; tokens are never logged
- GitHub adapter is GET-only
- Git hooks are disabled in the run workspace
- Unknown requester and missing authority are denial
- Duplicate idempotency keys do not create a second run
- Failed lock lookup is never treated as an acquired lock
- Missing repository truth fails closed
- Dangerous operations remain behind disconnected / disabled ports
