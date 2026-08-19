# Phase 11 — Durable state, transactional integrity, distributed coordination

## Core distinctions

```text
PROCESS MEMORY != SYSTEM OF RECORD
DATABASE ROW != DOMAIN AUTHORITY
LEASE OWNERSHIP != BUSINESS AUTHORIZATION
DELIVERY AT LEAST ONCE != SIDE EFFECT EXACTLY ONCE
RUNNING + PROCESS CRASH != SAFE TO RETRY
STALE WORKER != AUTHORIZED WRITER
LOCAL FILE PATH != DISTRIBUTED ARTIFACT AUTHORITY
APPLICATION CLOCK != DISTRIBUTED LEASE CLOCK
```

**EXACTLY-ONCE EXTERNAL SIDE EFFECTS ARE NOT ASSUMED.**

Distributed execution provides durable idempotency identity, bounded side-effect fencing, reconciliation, and containment on uncertainty.

## Storage modes

| Mode | Env | Behavior |
| --- | --- | --- |
| `memory` | `ORCHESTRATOR_STORAGE=memory` (default) | Phase 0–10 in-memory adapters; fast unit tests |
| `postgres` | `ORCHESTRATOR_STORAGE=postgres` + `DATABASE_URL` | Durable adapters; **fail closed** if DB unavailable |

Configured `postgres` mode never silently falls back to memory.

## PostgreSQL setup (local)

```bash
docker compose -f docker-compose.postgres.yml up -d
export DATABASE_URL=postgres://orchestrator:orchestrator@127.0.0.1:5432/orchestrator
export ORCHESTRATOR_STORAGE=postgres
npm run db:migrate
npm run test:postgres
```

## Migrations

- Versioned SQL under `migrations/`
- Ordered, checksumable, idempotent runner
- PostgreSQL advisory lock prevents concurrent schema migration
- Startup checks schema compatibility (`DATABASE_SCHEMA_OUT_OF_DATE`)

```bash
npm run db:migrate
npm run db:status
```

## Transaction boundaries

| Boundary | Atomic writes |
| --- | --- |
| Admission | run + objective + idempotency + event (when `transactions` wired) |
| Authorization routing | outbox enqueue in TX; delivery via dispatcher outside TX |
| Execution resources | `execution_resource_ledgers` durable per attempt |
| Execution start | attempt + authority snapshot + run EXECUTING |
| Verification success | OutcomeVerification + CompletionRecord + run COMPLETED |
| Memory promotion | decision + precedent + ledger event (when `transactions` wired) |

Model calls and SafeActuator **must not** run inside open database transactions.

## Leases and fencing

- Coordinator leases stored in `coordinator_leases`
- Validity uses PostgreSQL `NOW()` — not application node clocks
- Monotonic `fenceToken`; stale owners receive `STALE_FENCE_TOKEN`

## Artifacts

- `artifact_blobs` stores bounded BYTEA content (max 1 MiB per artifact)
- Verification recomputes hash from durable bytes when `blobStore` is configured
- Local filesystem paths remain valid in memory/dev mode only

## Recovery

`DurableRecoveryService` performs safe reconciliation only:

- expired leases → `REACQUIRED`
- RUNNING steps → `UNSAFE_TO_RETRY` / contain
- DISPATCH_STARTED inference → `REQUIRES_MANUAL_REVIEW` / conservative charge

No blind retry of uncertain side effects.

## Backup contract

PostgreSQL backup must preserve:

- database state (including `artifact_blobs` and migration history)
- restored snapshots must remain internally consistent

This repository does not ship a backup product.

## Integration tests

Real PostgreSQL integration tests require `TEST_DATABASE_URL` or Docker.

If PostgreSQL is unavailable during CI, integration tests skip explicitly — distributed semantics are not claimed tested in that environment.
