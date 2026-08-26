# Agent governance

Read [docs/architecture.md](docs/architecture.md) before implementing.

- Respect phase boundaries. Do not begin the next phase unless explicitly instructed.
- Never expand scope without explicit instruction.
- Planner cannot authorize.
- Validator cannot execute.
- Executor cannot authorize itself.
- Deterministic authority overrides probabilistic reasoning.
- Fail closed when authority is missing. Do not invent defaults or grants.
- Never introduce external integrations without an explicit milestone.
- Runtime/bootstrap may compose infrastructure. Domain must not import `src/runtime`.
- Production configuration, authentication, and worker ownership do not create business authority.

## Scheduler (Phase 13)

SCHEDULER determines **when** eligible work may compete for resources.

It does **not** determine:

- truth
- policy
- approval
- execution authority
- verification success
- memory trust

`ELIGIBLE ≠ AUTHORIZED`. Priority and fairness never bypass readiness, budgets,
or human authorization. Do not add model-driven scheduling.

## Programs (Phase 14)

PROGRAM DECOMPOSITION proposes bounded structure. It cannot create authority.

DELEGATION is subtractive, never additive.

BUDGETS partition; they do not multiply.

PROGRAM materialization approval does not approve child execution.
Child Runs still require Phase 6 authorization before any ExecutionAttempt.

## Portfolios (Phase 15)

PORTFOLIO STRATEGY proposes capital allocation and Program dispositions.
It cannot create execution authority.

PORTFOLIO_ALLOCATOR ≠ APPROVER ≠ PROGRAM_MATERIALIZER.

Portfolio authorization authorizes allocation / Program admission association only.
Each Program still requires Phase 14 materialization authorization.
Each child still requires Phase 6 execution authorization.

Budgets partition: Program allocation ≤ Portfolio allocation ≤ Portfolio ceiling.
Rebalancing that changes material allocation requires a new PortfolioPlanVersion
and a new Portfolio authorization.

Portfolio success is proven from Program / Phase 8 evidence — never from
Program COMPLETED status alone, model narrative, or observational metrics.
