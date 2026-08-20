# Phase 12 — Production readiness

Phase 12 changes **how** the orchestrator is operated, not **what** it is authorized to decide.

```text
domain
 ↑
application
 ↑
infrastructure
 ↑
runtime/bootstrap
```

Runtime may compose domain, application, and infrastructure.
**Domain MUST NOT import runtime.**
Application MUST NOT import production deployment concerns.

## Production authority statement

- Runtime configuration does not create policy authority.
- Authentication does not create approval authority.
- Worker ownership does not create execution authorization.
- Readiness does not create business truth.
- Metrics do not create policy.
- Deployment version does not create authority.

Outbox delivery is **at-least-once**. Durable inbox/idempotency prevents duplicate
authoritative consumer effects. This is not exactly-once transport.

HTTP perimeter identity, requester grants, and approver decisions remain distinct.

`ANONYMOUS` authentication is forbidden in `PRODUCTION`.
`MEMORY` storage is forbidden in `PRODUCTION`.

## HTTP route classes

| Class | Examples |
| --- | --- |
| PUBLIC_OPERATIONAL | `/health/live`, `/health/ready`, `/health/info` |
| AUTHENTICATED_READ | GET run/plan/authorization/execution |
| AUTHENTICATED_MUTATION | POST admit/ingest/plan/execute/verify/learn |
| APPROVER_OPERATION | POST approval decision (still requires approver domain authority) |
| INTERNAL_ONLY | `/ops/diagnostics` (authenticated, read-only) |

## Startup

`CREATED → CONFIG_VALIDATED → DATABASE_CONNECTED → SCHEMA_VERIFIED → RECOVERY_RUNNING → RECOVERY_COMPLETE → SERVICES_READY → ACCEPTING_TRAFFIC`

Failure: `STARTUP_FAILED`. No HTTP listen, worker claim, model dispatch, or actuator dispatch before prerequisites complete.

## Invariants preserved from Phase 11

Lease ownership is not business authorization. Stale workers are not authorized writers. Logs are not EventStore. Metrics are not policy.
