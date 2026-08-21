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
