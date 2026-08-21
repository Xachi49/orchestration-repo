# Scheduling authority boundary

## Explicit separations

| Concept | Meaning |
|---|---|
| ELIGIBLE | Scheduler may claim for capacity |
| AUTHORIZED | Durable human/authorization record permits execution |
| PRIORITY | Ordering hint among eligible work |
| POLICY | Control-plane rules — unchanged by scheduler |
| QUEUE POSITION | Fairness/score outcome |
| BUSINESS IMPORTANCE | Not inferred from queue position |
| LEASE OWNERSHIP | Temporary claim to attempt dispatch |
| EXECUTION AUTHORIZATION | Binding + readiness + APPROVED state |
| DEPENDENCY SATISFIED | Prerequisite milestone on durable truth |
| VALIDATION PASS | Independent validator outcome — not approval |
| CAPACITY AVAILABLE | Scheduler concurrency slot |
| BUDGET AVAILABLE | Execution resource ledger |
| DISPATCH | Invoke existing phase service |
| PERMISSION | Domain grant — not scheduler |
| AUTONOMOUS PROGRESSION | Advance eligible phases without human clicks |
| AUTONOMOUS APPROVAL | **Forbidden** |

## Human approval barrier

After validation PASS / HUMAN_APPROVAL_REQUIRED, the scheduler may only
`ROUTE_AUTHORIZATION`. Progression stops at `AWAITING_APPROVAL` until a legal
human decision produces durable `APPROVED`. No timers, no auto-approve.

## Stale work

Work items bind to authority fingerprints (repo, plan hash/version, auth
record, attempt, completion). Pre-dispatch recompute; drift cancels work
(`PLAN_REPLACED`, `AUTHORIZATION_CHANGED`, …) without executing.

## Observability

Phase 10/12 may measure scheduler metrics. They must not auto-mutate weights,
priorities, caps, or retry budgets.
