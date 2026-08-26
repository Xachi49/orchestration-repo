# Phase 16 — Scenario Intelligence

Strategic decision problems sit above Portfolios. A decision problem frames a
question, generates bounded scenarios, simulates outcomes, packages analysis,
and routes human strategy selection. Selection binds scenario choice only —
it does **not** authorize portfolio allocation, Program materialization, or
Phase 6 execution.

## Authority ladder

```text
CONTROL PLANE
  ↓
DECISION PROBLEM ADMISSION
  ↓
TRUTH GROUNDING + SCENARIO GENERATION (proposal only)
  ↓
SIMULATION (estimates — never facts)
  ↓
DECISION PACKAGE VALIDATION
  ↓
STRATEGY SELECTION (STRATEGY_SELECTOR)
  ↓
PORTFOLIO PROPOSAL MATERIALIZATION (admit-only hook)
  ↓
PORTFOLIO AUTHORIZATION (PORTFOLIO_ALLOCATOR) — separate gate
  ↓
… Phase 15 / 14 / 6 ladder …
```

**STRATEGY_SELECTOR ≠ PORTFOLIO_ALLOCATOR ≠ PROGRAM_MATERIALIZER ≠ APPROVER.**

Simulation ranks and recommends; humans select. Calibration records are
observational only — never selection authority.

## Governing rules

- **SIMULATION ≠ SELECTION** — ranked scenarios are recommendations only.
- **STRATEGY_SELECTOR** grants are per-project and fail-closed: the deciding
  principal must hold an explicit grant for **every** project in
  `allowedProjectIds`.
- **Selection does not allocate capital** — `SELECT_SCENARIO` binds strategic
  choice; `materializePortfolioProposal` requires a `PortfolioProposalAdmissionPort`
  and admits a proposed Portfolio into Phase 15 (`ADMITTED` / deterministic
  `DUPLICATE` only). Missing port fails closed with `PORTFOLIO_ADMISSION_UNAVAILABLE`
  and leaves the DecisionProblem `SELECTED`. Capital reservation and
  `PORTFOLIO_ALLOCATOR` authorization remain separate governed gates.
- **STRATEGY_SELECTOR scope** — principal must hold an explicit
  `STRATEGY_SELECTOR` grant for **every** project in `allowedProjectIds`
  (intersection). APPROVER / PROGRAM_MATERIALIZER / PORTFOLIO_ALLOCATOR never imply it.
- **Decision weights** — `MODEL_SUGGESTED_WEIGHT ≠ AUTHORITATIVE_DECISION_WEIGHT`.
  Comparison and recommendations use only `DecisionProblem.decisionCriteria`
  (frozen into `StrategicDecisionPackage.authoritativeDecisionCriteria`).
- **Truth drift** marks packages `STALE` and fails selection/materialization
  closed with `PACKAGE_STALE`; re-analysis required.
- **Budgets partition** simulation usage (`maximumSimulationRuns`,
  `maximumModelCalls`, `maximumSensitivityEvaluations`) — exceeded budgets fail
  closed.
- **Progression**: `ScenarioProgressionLoop` only discovers work and materializes
  SchedulerWorkItems. Authoritative scenario mutations run only after Phase 13
  claim/fence/dispatch.

## Lifecycle

```text
ADMITTED → GROUNDING → SCENARIOS_PROPOSED → SIMULATING → ANALYZING
  → VALIDATING → AWAITING_SELECTION  (STRATEGY_SELECTOR gate)
  → SELECTED → MATERIALIZED_AS_PROPOSAL
```

`STALE` may restart from `GROUNDING`. Terminal: `MATERIALIZED_AS_PROPOSAL`,
`CANCELLED`.

## Primary packages

- `src/scenarios/` — domain, simulation, comparison, orchestration service
- `migrations/011_phase16_scenario_intelligence.sql` — durable tables
- `src/scheduling/scenario-discovery-map.ts` — scheduler work identity per state
- `src/api/decisions.ts` — HTTP surface for decision problems
- Tests: `src/scenarios/scenarios.test.ts`,
  `src/infrastructure/postgres/postgres.phase16.test.ts`

## Evidence classes

Scenario outputs carry explicit authority classes (`CURRENT_CONTROL_PLANE_TRUTH`,
`ASSUMPTION`, `MODEL_ESTIMATE`, `VERIFIED_*`, observational / external refs).
Forecasts are estimates, not facts. Only Phase 8 verification evidence may
upgrade claims to verified outcomes.
