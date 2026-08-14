# Orchestrator Agent — Phase 0 Foundation

Evidence-grounded, policy-governed orchestration contracts and run-state architecture.

**Package name:** `orchestrator-agent`  
**Repository folder / remote:** `orchestration-repo`  
**Branch intent:** `bootstrap/orchestrator-foundation`

> AI may determine what could be useful. Deterministic systems determine what is true, permitted, affordable, authorized, executable, successful, and worthy of being remembered.

## What this phase implements

Phase 0 establishes a **trustworthy deterministic foundation** before any probabilistic components:

- Strongly typed domain contracts (Zod + TypeScript) for Objective, Event Envelope, Evidence, Execution Plan/Step, and Validation Decision
- Deterministic run-state machine with explicit transitions (fail closed)
- Objective idempotency key derivation from identity fields (not outcome text)
- Canonical plan serialization and `PlanHasher` (SHA-256)
- Architectural boundary ports for planner / validator / approver / executor / memory / control-plane
- Minimal Fastify `/health` endpoint (no orchestration API yet)
- Unit tests for contracts, transitions, idempotency, hashing, and validation decisions

## What is intentionally unimplemented

- LLM / OpenAI / Anthropic connections
- GitHub (or other SCM) API integrations
- Real plan generation, admission, ingestion, approval workflows
- Execution, rollback, containment behavior
- Discord / Slack / n8n / autonomous tool access
- Distributed idempotency locks
- Secret management or credential storage
- Shell / command execution abstractions with active implementations

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
├── control-plane/       # Projects, capabilities, policies, budgets (ports)
├── admission/
├── ingestion/
├── planning/
├── validation/
├── approval/
├── execution/
├── verification/
├── memory/
├── observability/
└── infrastructure/      # Replaceable ports (clock, ids; LLM/GitHub disconnected)
```

Authority separation is explicit: planners propose, validators validate, approvers authorize exact plan versions, executors run only authorized actions, memory stores verified outcomes without overriding policy.

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

## Security posture (Phase 0)

- No `eval`
- No dynamic execution of retrieved content
- No hardcoded secrets
- External content treated as untrusted by ingestion contracts
- Dangerous operations remain behind disconnected / disabled ports
