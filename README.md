# Orchestrator Agent

Evidence-grounded, policy-governed orchestration contracts, run-state architecture, and deterministic control plane.

**Package name:** `orchestrator-agent`  
**Repository folder / remote:** `orchestration-repo`

> AI may determine what could be useful. Deterministic systems determine what is true, permitted, affordable, authorized, executable, successful, and worthy of being remembered.

## Current milestone: Phase 1 — Deterministic Control Plane

Phase 1 adds **configuration authority** on top of the Phase 0 foundation:

- Project, capability, policy-bundle, and resource-budget registries
- Fail-closed `ControlPlaneService` that assembles `ProjectControlContext`
- In-memory adapters for tests and local development
- Example fixtures for `discord-scale-architect` (no real external authority)

See [docs/architecture.md](docs/architecture.md) for the Control Plane design.

The Control Plane defines what may eventually be permissible. It does **not** execute anything.

## Phase 0 (still in place)

- Strongly typed domain contracts (Zod + TypeScript) for Objective, Event Envelope, Evidence, Execution Plan/Step, and Validation Decision
- Deterministic run-state machine with explicit transitions (fail closed)
- Objective idempotency key derivation from identity fields (not outcome text)
- Canonical plan serialization and `PlanHasher` (SHA-256)
- Architectural boundary ports for planner / validator / approver / executor / memory
- Minimal Fastify `/health` endpoint (no orchestration mutation API)

## What is intentionally unimplemented

- LLM / OpenAI / Anthropic connections
- GitHub (or other SCM) API integrations
- Real plan generation, admission, ingestion, approval workflows
- Execution, rollback, containment behavior
- Discord / Slack / n8n / autonomous tool access
- Distributed idempotency locks
- Policy evaluation engine / OPA
- Secret management or credential storage
- Shell / command execution abstractions with active implementations
- Production databases

## Architecture

```text
src/
├── api/                 # Minimal HTTP surface
├── domain/              # Typed contracts + deterministic helpers
│   ├── objective/
│   ├── run/
│   ├── plan/
│   ├── evidence/
│   └── validation/
├── control-plane/       # Configuration authority
│   ├── projects/
│   ├── capabilities/
│   ├── policies/
│   └── budgets/
├── admission/
├── ingestion/
├── planning/
├── validation/
├── approval/
├── execution/
├── verification/
├── memory/
├── observability/
└── infrastructure/      # Replaceable adapters (in-memory registries)
```

## Technical baseline

- TypeScript (strict)
- Node.js **≥22** (spec baseline: Node.js 24 LTS; local bootstrap verified on Node 22 when 24 is unavailable)
- Fastify
- Zod
- Vitest
- ES modules

## Commands

```bash
npm install
npm run typecheck
npm test
npm run build
```

Health server (optional):

```bash
npm start
# GET http://127.0.0.1:3000/health
```

## Security posture

- No `eval`
- No dynamic execution of retrieved or stored configuration
- No hardcoded secrets
- Missing capability or policy information is denial, not permission
- External content treated as untrusted by ingestion contracts
- Dangerous operations remain behind disconnected / disabled ports
