# Phase 15 — Strategic Portfolio Orchestration

Portfolios sit above Programs. A Portfolio proposes capital allocation across
bounded Programs that contribute to strategic goals. Portfolio authorization
admits Programs into the portfolio — it does **not** authorize Program
decomposition, child Run materialization, or Phase 6 execution.

## Authority ladder

```text
CONTROL PLANE
  ↓
PORTFOLIO AUTHORIZATION (PORTFOLIO_ALLOCATOR)
  ↓
PORTFOLIO ALLOCATION (reservation / escrow)
  ↓
PROGRAM ADMISSION
  ↓
PROGRAM MATERIALIZATION AUTHORIZATION (PROGRAM_MATERIALIZER)
  ↓
CHILD OBJECTIVE ADMISSION
  ↓
PHASE 6 EXECUTION AUTHORIZATION (APPROVER)
  ↓
EXECUTION
  ↓
VERIFICATION
  ↓
PROGRAM COMPLETION
  ↓
PORTFOLIO VERIFICATION
  ↓
PORTFOLIO COMPLETION
```

**PORTFOLIO_ALLOCATOR ≠ PROGRAM_MATERIALIZER ≠ PHASE 6 APPROVER.**

Each gate binds a distinct subject hash. Lower gates never inherit upper gates.

## Governing rules

- **STRATEGY ≠ AUTHORITY** — model recommendations are proposal input only.
- **PORTFOLIO_PLAN_VALID ≠ PORTFOLIO_AUTHORIZED**
- **Portfolio authorization ≠ Program materialization ≠ child execution**
- **Budgets partition; they do not multiply.**
  `Program allocation ≤ Portfolio allocation ≤ Portfolio ceiling`
- **Concentration** is always evaluated on exactly one envelope-configured
  basis (`concentrationBasis`: `ESTIMATED_COST` | `TOTAL_TOKENS`). Denominator =
  **total proposed allocation on that basis only**. Never mix units, never
  fall back per Program. Incomplete basis →
  `INSUFFICIENT_CONCENTRATION_BASIS`. A 100% single-Program share is valid only
  when `allocationConcentrationCeiling` explicitly permits `1.0`. Changing
  `concentrationBasis` changes the envelope hash.
- **Rebalancing that changes material allocation** requires a new
  `PortfolioPlanVersion` and a new Portfolio authorization.
- **Portfolio COMPLETED** requires `PortfolioCompletionRecord` with goal proof
  chains through Program completion **criterion-level** evidence — never from
  Program `COMPLETED` status alone or observational metrics.
- **PORTFOLIO_ALLOCATOR** grants are per-project and fail-closed: the deciding
  principal must hold an explicit grant for **every** project in the Portfolio
  envelope. APPROVER / PROGRAM_MATERIALIZER never imply allocator authority.
- **Progression**: `PortfolioProgressionLoop` only discovers work and materializes
  SchedulerWorkItems. Authoritative Portfolio mutations run only after Phase 13
  claim/fence/dispatch.

## Lifecycle

```text
ADMITTED → ANALYZING → PLANNED → VALIDATING
  → AWAITING_AUTHORIZATION  (PORTFOLIO_ALLOCATOR gate)
  → AUTHORIZED → ACTIVE → VERIFYING → COMPLETED
```

`REBALANCE_REQUIRED` forces replanning and a fresh authorization binding before
material allocation may change. `PortfolioProgressionLoop` and
`PortfolioWorkMaterializer` coordinate scheduler work; they do not bypass human
gates.

## Primary packages

- `src/portfolio/` — domain, validator, budget escrow, orchestration service
- `migrations/010_phase15_portfolios.sql` — durable tables
- `src/scheduling/portfolio-discovery-map.ts` — scheduler work identity per state
- Tests: `src/portfolio/portfolio.test.ts`,
  `src/infrastructure/postgres/postgres.phase15.test.ts`

## Goal proof chain

```text
PortfolioGoal → contribution binding → Program → ProgramCompletionRecord
  → Phase 8 outcome evidence refs
```

Bindings must match criterion identity exactly. A Program proving criterion A
cannot satisfy an unrelated Portfolio goal B.
