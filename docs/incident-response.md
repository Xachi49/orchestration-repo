# Incident response

Operational containment only. Do not force-approve, force-execute, force-complete, or force-promote.

## Database unavailable

1. Readiness becomes false.
2. Mutations fail closed.
3. Do not switch to MEMORY storage.
4. Process may remain live (`/health/live`).
5. Restore PostgreSQL; readiness may recover.
6. Durable rows remain canonical.

## Worker crash / API crash

1. Start a new process with a **new** `ORCHESTRATOR_INSTANCE_ID`.
2. Startup recovery scans expired leases, RUNNING steps, ambiguous inference, outbox leases.
3. RUNNING unknown effects → `UNSAFE_TO_RETRY` / contain. Do not blind-retry actuators.
4. Stale fence tokens are rejected.

## Stale lease

Owner lost heartbeat. New owner may acquire a higher fence. Previous owner must not complete terminal writes.

## Ambiguous model dispatch

Do not redispatch. Conservative charge. Manual review.

## Approval delivery timeout

At-least-once outbox retry with inbox idempotency. Missing delivery secret fails closed.

## Outbox dispatcher crash

Reclaim expired `LEASED` rows. Consumers must be idempotent. Not exactly-once transport.

## Secret leak suspected

Rotate `APPROVAL_DELIVERY_SECRET_KEY` and `DATABASE_URL` credentials outside the process. Do not write replacements into EventStore.
