# Scheduler runtime

## Processes

When `runtimeRole` is not `API` and storage is PostgreSQL, the worker loop runs:

1. **outbox** — Phase 12 approval delivery (unchanged)
2. **scheduler-discovery** — bounded
   `listActionableDiscoverableRunIds(DISCOVERABLE_RUN_STATES)` then idempotent
   `discoverBatch`. Candidates are Runs whose current-phase scheduler work is
   **not** already durably represented. Ordering is oldest-actionable-first
   (`updated_at ASC`) so continuous admission cannot starve older missing-work
   Runs. Already-materialized work items govern their own retry/eligibleAt —
   rediscovery does not rematerialize them.
3. **scheduler-claim** — `selectAndClaimWork` (atomic) → fenced phase dispatch **outside**
   the allocation transaction

Global worker concurrency (`ORCHESTRATOR_WORKER_CONCURRENCY`) bounds claim
dispatch. Discovery and claim both honor `DrainController.isAcceptingWork()`
and `db.ping()` (fail closed on outage).

## Configuration

| Concern | Source |
|---|---|
| Global scheduler concurrency | Stack option `schedulerGlobalMaxConcurrency` (default 16), separate from execution resource ledger |
| Project weight / max concurrency / default priority | `scheduler_project_config` |
| Pause | `scheduler_pauses` (GLOBAL or PROJECT) |
| Worker capability labels | Claim loop `workerCapabilities` (operational routing only) |

## Drain (SIGTERM)

Discovery and claim stop accepting new work. In-flight dispatch completes under
existing phase fencing. Ambiguous phase effects are not blindly retried by the
scheduler — Phase 11/12 recovery remains authoritative.

## Fairness (durable) and allocation atomicity

Deficit round-robin state is stored in `scheduler_fairness_state` and serialized
via `scheduler_fairness_lock` (`SELECT … FOR UPDATE`).

Canonical path `selectAndClaimWork` runs one short transaction:

1. lock fairness coordination row
2. load **current** durable deficits
3. discover **schedulable project contenders** (`DISTINCT project_id` among currently
   `ELIGIBLE` due work — not a historical census, not a global work-item `LIMIT`)
4. bounded per-project work page (`perProjectLimit`)
5. establish claim with existing Phase 11 `coordinator_leases` / fence
6. on claim success: apply fairness service charge (revision CAS) + decision record
7. `COMMIT`

Phase planning/validation/execution/verification/network delivery must not run
inside that transaction.

Crash before commit → no durable claim and no fairness charge.  
Commit succeeds → claim and charge both durable.

`markClaimed` alone does **not** advance fairness (avoids claim-without-credit and
credit-without-claim races when used outside the atomic path).

**Active capacity** = work in `CLAIMED`/`RUNNING` with a live Phase 11 lease
(`HELD` and `lease_expires_at >= NOW()`). Expired `CLAIMED` is reconciled to
`ELIGIBLE` before selection (safe re-claim after crash-before-dispatch).
Expired `RUNNING` is not auto-requeued.

Restarting schedulers reloads deficits from PostgreSQL — process heaps are not
authority.

### Weighted fairness finite-window note

Deficit round-robin with weights 1 vs 3 converges toward a 3:1 long-run share.
Over a short claim window (e.g. 40 claims), acceptance uses a looser bound
(`B/A >= 1.5`) because discrete DRR quanta and interleaved eligibility produce
variance; the suite still requires the higher-weight project to receive
materially more service.
