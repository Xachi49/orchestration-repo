# Program completion semantics

## Progress vs success

Reconciliation may report `3/5 required nodes complete`. That is observational.

Program completion requires:

1. every root acceptance criterion has a `SATISFIES` binding
2. bound child Runs are `COMPLETED`
3. each bound child has a durable `CompletionRecord`
4. immutable `ProgramCompletionRecord` is written transactionally with `COMPLETED`

## Outcomes

| Class | Meaning |
|---|---|
| `VERIFIED_SUCCESS` | All required root criteria proven |
| `PARTIAL_SUCCESS` | Deterministic subset proven (reserved for explicit future policy) |
| `PROGRAM_FAILED` | Required child terminal failure blocks success |
| `INCONCLUSIVE` | Evidence missing; escalated |
| `CONTAINED` | Safety containment |

Optional child failure does not block success when required criteria remain fully proven.
Malformed `COMPLETED` without `CompletionRecord` does not count.
