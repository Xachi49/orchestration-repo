# Runtime operations

## Roles

| Role | Responsibility |
| --- | --- |
| `API` | HTTP only |
| `WORKER` | bounded outbox/recovery loops only |
| `COMBINED` | both |

Roles do not change domain authority.

## Environment variables

| Variable | Notes |
| --- | --- |
| `ORCHESTRATOR_ENV` | `TEST` `DEVELOPMENT` `STAGING` `PRODUCTION` |
| `ORCHESTRATOR_STORAGE` | `memory` or `postgres` (PRODUCTION requires postgres) |
| `DATABASE_URL` | required for postgres/PRODUCTION |
| `ORCHESTRATOR_AUTH_MODE` | `ANONYMOUS` `HEADER_PRINCIPAL` `STATIC_PRINCIPAL` |
| `ORCHESTRATOR_STATIC_PRINCIPAL_ID` | for STATIC_PRINCIPAL |
| `ORCHESTRATOR_ACCESS_BINDINGS` | `principal:project[,project];...` HTTP access only |
| `APPROVAL_DELIVERY_SECRET_KEY` | 32-byte base64; never log |
| `ORCHESTRATOR_INSTANCE_ID` | unique per process; default random UUID |
| `ORCHESTRATOR_WORKER_CONCURRENCY` | 1–64 |
| `ORCHESTRATOR_SHUTDOWN_GRACE_MS` | drain bound |
| `GIT_COMMIT_SHA` / `BUILD_TIMESTAMP` | non-secret build identity |

Never persist secrets into git, images, logs, EventStore, or outbox general payloads.

## Liveness vs readiness

- `/health/live` — process can respond
- `/health/ready` — config, DB, schema, recovery, not draining
- Model provider unavailability does not fail liveness

## Shutdown

`SIGTERM`/`SIGINT` → `DRAINING` (readiness false, no new claims) → `STOPPED`.

Graceful shutdown does **not** rewrite RUNNING steps into safe retries. Phase 11 containment/recovery remains authoritative for uncertain side effects.

## Workers

Polling uses bounded delay + jitter. Concurrency is capped. Outbox delivery is at-least-once with durable idempotent consumers. Permanent `FAILED` after configured max attempts. No generic retry-forever.

## Retry classes

See `src/runtime/retry.ts`: `SAFE_READ_RETRY`, `IDEMPOTENT_DELIVERY_RETRY`, `COORDINATION_RETRY`, `UNSAFE_SIDE_EFFECT_RETRY`, `AMBIGUOUS_MODEL_DISPATCH`, `NO_RETRY`.
