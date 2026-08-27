# Phase 17 — Governed Experimentation

Governed experiments sit beside Scenarios and Portfolios. An experiment binds
hypotheses to measurable outcomes, designs a bounded plan, routes human
sponsorship, compiles execution lineage, and records verified evidence.
Sponsorship does **not** authorize Phase 6 execution, Program materialization,
or portfolio allocation.

## Authority ladder

```text
CONTROL PLANE
  ↓
EXPERIMENT ADMISSION
  ↓
DESIGN (proposal only — FakeExperimentDesignModel / design model)
  ↓
VALIDATION (deterministic plan checks)
  ↓
EXPERIMENT SPONSORSHIP (EXPERIMENT_SPONSOR)
  ↓
EXECUTION COMPILATION (lineage only — no Phase 6 auth)
  ↓
PHASE 6 AUTHORIZATION + EXECUTION (separate gate)
  ↓
VERIFICATION + EVIDENCE BUNDLE
  ↓
ASSUMPTION UPDATE CANDIDATES (observational — Phase 16 re-analysis required)
```

**EXPERIMENT_SPONSOR ≠ STRATEGY_SELECTOR ≠ PORTFOLIO_ALLOCATOR ≠ PROGRAM_MATERIALIZER ≠ APPROVER.**

Experiments produce evidence. They do not produce authority.

## Governing rules

- **EXPERIMENT_AUTH ≠ EXECUTION_AUTH** — `APPROVE_EXPERIMENT` never creates a
  Phase 6 AuthorizationRecord or ExecutionAttempt.
- **EXPERIMENT_SPONSOR** grants are per-project and fail-closed: the deciding
  principal must hold an explicit grant for the experiment `projectId`.
  APPROVER / STRATEGY_SELECTOR / PORTFOLIO_ALLOCATOR never imply it.
- **Compilation is lineage only** — `compileExecution` records
  `ExperimentExecutionLineage` and leaves the experiment
  `AWAITING_EXECUTION_AUTHORIZATION`.
- **Truth drift** marks experiments `STALE` and fails closed; re-design or
  re-validate required.
- **Budgets partition** design / model / sample usage — exceeded budgets fail
  closed.
- **Assumption candidates** set `requiresPhase16Reanalysis: true` and never
  mutate AssumptionSets in place.
- **Progression**: `ExperimentProgressionLoop` only discovers work and
  materializes SchedulerWorkItems. Authoritative experiment mutations run only
  after Phase 13 claim/fence/dispatch.

## Lifecycle

```text
ADMITTED → DESIGNING → VALIDATING → AWAITING_AUTHORIZATION
  → AUTHORIZED → AWAITING_EXECUTION_AUTHORIZATION
  → EXECUTING → VERIFYING → COMPLETED | INCONCLUSIVE
```

`STALE` may restart from `DESIGNING`. Terminal: `COMPLETED`, `INCONCLUSIVE`,
`CANCELLED`.

## Primary packages

- `src/experiments/` — domain, design model, orchestration service
- `migrations/012_phase17_governed_experiments.sql` — durable tables
- `src/scheduling/experiment-discovery-map.ts` — scheduler work identity per state
- `src/api/experiments.ts` — HTTP surface for governed experiments
- Tests: `src/experiments/` unit coverage,
  `src/infrastructure/postgres/postgres.phase17.test.ts`

## Evidence classes

Measurement payloads are observational DATA only. Authoritative evidence quality
is **derived from Phase 8** `OutcomeVerificationRecord` bindings resolved through
`ExperimentOutcomeVerificationPort` — never from caller/model `quality` fields.

- `SUPPORTED` / `NOT_SUPPORTED` require Phase 8 `VERIFIED_SUCCESS` bound to the
  experiment execution lineage run.
- Missing, fabricated, cross-run, or cross-project verification refs fail closed.
- `INCONCLUSIVE` may be recorded after verification when sample/quality is
  insufficient — it does **not** authorize numeric assumption promotion.
- Assumption update candidates bind exact evidence hashes and Phase 8 identities;
  they never mutate AssumptionSets in place (Phase 16 re-analysis required).

## Phase 2 handoff

`compileExecution` delegates to `ExperimentObjectiveAdmissionPort` (production:
`Phase2ExperimentObjectiveAdmissionPort` → real Phase 2 admission). Missing port
fails closed; experiment remains `AUTHORIZED` with no lineage and no
`AWAITING_EXECUTION_AUTHORIZATION`. Duplicate Objective identity is reused on
crash retry.

## Budgets

`ExperimentUsageLedger` enforces CAS-fenced ceilings for design/model calls,
sample counts, and action reservations around Phase 2 admission. Concurrent
oversubscription and crash-replay double-charging fail closed / conserve usage.
