# Phase 13 — Portfolio orchestration

Phase 13 turns the governed orchestrator into a portfolio-scale progression
engine: many projects, objectives, runs, and phases, with durable work items
and distributed claiming.

## Governing rule

**SCHEDULING ≠ AUTHORITY**

| Scheduler may decide | Scheduler must not decide |
|---|---|
| When eligible work competes for capacity | Whether work is authorized |
| Priority / fairness / aging order | Policy, capability, budget truth |
| Claim ownership for dispatch | Approval, verification success, precedent trust |

Every dispatch reloads durable state and re-runs the owning phase’s readiness.

## Progression (happy path)

```
ADMITTED → INGEST → INGESTING → PLAN → VALIDATING → VALIDATE
→ ROUTE_AUTHORIZATION → AWAITING_APPROVAL
        [human APPROVE only]
→ APPROVED → EXECUTE → EXECUTING → VERIFY → COMPLETED
→ LEARN → OBSERVABILITY
```

`ROUTE_AUTHORIZATION` creates the human gate. It is **not** approval.
While `AWAITING_APPROVAL`, discovery yields **no** `EXECUTE_PLAN`.

## Modules

- `src/scheduling/` — types, discovery map, eligibility, fairness, score,
  service, dispatcher, loops (domain/application; no model imports)
- `migrations/004_phase13_scheduler.sql` — durable work/deps/decisions/config/pauses
- `migrations/005_phase13_fairness.sql` — durable cross-runtime fairness state
- `migrations/006_phase13_contender_indexes.sql` — project-aware schedulable indexes
- `migrations/007_phase13_actionable_discovery.sql` — actionable discovery indexes
- `src/infrastructure/postgres/repositories/scheduler.ts` — Postgres stores
- HTTP: `/v1/portfolio`, `/v1/projects/:id/work`, `/v1/runs/:id/work`,
  `/v1/work-items/:id`, pause/resume, dependency registration

## Claiming

Reuses Phase 11 `coordinator_leases` with key `scheduler:work:{workItemId}`.
Stale fence tokens cannot settle work (`LeaseFencedWorkStateWriter`).

Allocation uses `selectAndClaimWork`: fairness lock + current deficits +
project-aware contender discovery + lease claim + service charge in one short
transaction. Phase dispatch stays outside that boundary.

**Live capacity** counts only `CLAIMED`/`RUNNING` rows with a HELD,
unexpired Phase 11 lease. Expired `CLAIMED` (crash before dispatch) is
reconciled back to `ELIGIBLE` for safe re-claim. Expired `RUNNING` is **not**
blindly requeued — Phase 11/12 recovery/containment applies.

## Contender discovery

Fairness operates across **projects with currently schedulable work**, discovered
via indexed `DISTINCT project_id` / `GROUP BY` on `ELIGIBLE` items — not by
loading a global `LIMIT N` work page (which a noisy project could fill).
Per-project work lookup remains bounded (`perProjectLimit`).

## Run discovery (materialization)

`listActionableDiscoverableRunIds` returns discoverable Runs whose current-phase
work is not already present on `scheduler_work_items`. Ordering is
oldest-actionable-first so continuous admission cannot starve older missing-work
Runs. Already-materialized items are excluded from the discovery page; retries
remain on the work-item lifecycle (`eligibleAt`, FAILED, lease recovery).

## Deficit round-robin

Every successful claim advances durable deficits:

1. each contender: `deficit += weight * 10`
2. selected: `deficit = max(0, deficit - 10)`

Higher weight accrues entitlement faster. Scheduling score boosts by deficit
(not by a permanent weight bias). `serviceSequence` counts per-project
successful services.
## Acceptance themes

- Idempotent discovery / unique logical identity
- Fairness across projects; per-project and global concurrency caps
- Cross-run dependencies with cycle rejection; COMPLETED requires CompletionRecord
- Human approval barrier
- Drain / DB outage: no memory queue fallback
- No LLM in scheduling decisions
