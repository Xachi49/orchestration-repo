# Phase 14 — Governed Programs

Programs sit above Objectives and Runs. A Program is a strategic aggregate that
may decompose into bounded child Objectives. Children still enter through Phase 2
admission, progress through Phase 13 scheduling, and stop at Phase 6 human
authorization for execution.

## Governing rules

- **DECOMPOSITION ≠ AUTHORITY** — model output is untrusted proposal data.
- **PROGRAM_PLAN_VALID ≠ MATERIALIZATION_AUTHORIZED**
- **Program materialization approval ≠ child execution approval**
- **DELEGATION is subtractive** — child authority is intersection only.
- **Budgets partition; they do not multiply.**
- **Program COMPLETED requires ProgramCompletionRecord** with explicit criterion bindings.

## Lifecycle

```text
ADMITTED → DECOMPOSING → DECOMPOSED → VALIDATING
  → AWAITING_MATERIALIZATION_APPROVAL  (human gate; no children)
  → MATERIALIZING → ACTIVE → VERIFYING → COMPLETED
```

`ProgramProgressionLoop` advances program phases. It does **not** replace the
Phase 13 run scheduler. While `AWAITING_MATERIALIZATION_APPROVAL`, progression
only routes the materialization approval request — it never creates Objectives
or Runs.

## Primary packages

- `src/programs/` — domain, validator, budget escrow, orchestration service
- `migrations/008_phase14_programs.sql` — durable tables
- `src/api/programs.ts` — authenticated program APIs
- Companion docs: `program-delegation-model.md`, `program-budget-authority.md`,
  `program-completion-semantics.md`
