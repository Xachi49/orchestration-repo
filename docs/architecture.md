# Architecture

The Orchestrator Agent translates high-level objectives into evidence-grounded plans.
Phase 0 defined domain contracts and a fail-closed run-state machine.
Phase 1 added **configuration authority**: the deterministic Control Plane.
Phase 2 added **admission authority**: objective admission and durable run identity.

> AI may determine what could be useful. Deterministic systems determine what is true, permitted, affordable, authorized, executable, successful, and worthy of being remembered.

## Authority separation

```text
PLANNER     proposes
VALIDATOR   evaluates
APPROVER    authorizes
EXECUTOR    acts
VERIFIER    measures outcomes
MEMORY      stores governed precedents
```

The Control Plane is none of those. It is **CONFIGURATION AUTHORITY**.

### CONFIGURATION AUTHORITY vs EXECUTION AUTHORITY

| Configuration authority (Phase 1) | Execution authority (deferred) |
| --- | --- |
| What projects exist | Changing a repository |
| Which capabilities exist and whether they are enabled | Invoking a capability |
| Which policy bundle is active | Evaluating a full policy engine against a live plan |
| Which resource ceilings apply | Spending tokens, calling APIs, running jobs |
| Whether an environment is listed as allowed | Connecting to that environment |

The Control Plane defines what may **eventually** be permissible.
It does **not** execute, approve, plan, or remember outcomes.

Missing or conflicting configuration fails closed. There are no default grants.

## Components

### Project Registry

Canonical project records: identity, repository metadata, allowed environments,
execution mode (`PLAN_ONLY` | `SUPERVISED` | `PATCH_ONLY`), active policy bundle id,
budget profile id, approvers, sensitivity classification, and status
(`ACTIVE` | `SUSPENDED` | `ARCHIVED`).

Execution mode is configuration authority only:

- `PLAN_ONLY`: planning and validation only; no side effects.
- `SUPERVISED`: future external execution may occur only through explicit authorization and bounded executors.
- `PATCH_ONLY`: future execution is limited to local patches/artifacts and specifically permitted verification. It does not imply arbitrary filesystem mutation, deployment, permission changes, or pushes to protected branches.

Port: `ProjectRegistry` — `getById`, `exists`, `list`.

A project can be read while `SUSPENDED` or `ARCHIVED`.
`ControlPlaneService` will not assemble an executable control context unless
the project is `ACTIVE` and the requested environment is listed.

### Capability Registry

A capability is a named, versioned description of something a future executor
might be permitted to do. It is not an executable tool.

Port: `CapabilityRegistry` — `getById`, `exists`, `list`, `isActionAllowed`.

`isActionAllowed` is exact-match and fail-closed:

- unknown capability → not permitted
- disabled capability → not permitted
- environment not listed → not permitted
- action in `forbiddenActions` → not permitted
- action not in `allowedActions` → not permitted (no inference)

### Policy Registry

Versioned policy bundles with status `DRAFT` | `ACTIVE` | `SUPERSEDED` | `REVOKED`.
Rules are stored as structured records (`ALLOW` | `DENY` | `REQUIRE_APPROVAL`).
Phase 1 does **not** evaluate a policy DSL and does not use OPA.

Port: `PolicyRegistry` — `getBundleById`, `getActiveBundleForProject`, `listVersions`.

Active-bundle resolution is deterministic and strict (not pointer-only):

1. status must be `ACTIVE`
2. `effectiveAt` must be ≤ now
3. project id must be listed in `applicableProjectIds` (empty list matches nothing)
4. environment must be listed in `applicableEnvironments`
5. zero matches → `POLICY_BUNDLE_NOT_FOUND`
6. more than one match → `POLICY_CONFLICT`
7. the unique resolved bundle id must equal `project.activePolicyBundleId`; otherwise → `POLICY_CONFLICT`

### Resource Budget Registry

Numeric ceilings for future LLM calls, tokens, API calls, execution time,
estimated cost, human review, plan steps, parallel workstreams, and revisions.

These values are **ceilings**, not live meters. Phase 1 never calls an LLM.

Port: `ResourceBudgetRegistry` — `getById`, `exists`, `list`.

`compareBudget(estimate, profile)` is a pure function returning:

- `WITHIN_BUDGET` (values equal to a maximum are inside)
- `BUDGET_EXCEEDED`
- `UNESTIMATED_RESOURCE` (fail closed if a required dimension is missing)

`allowedExecutionWindows` are stored and schema-validated.
Stored configuration authority; runtime enforcement deferred to the admission/execution phases.
Phase 1 does **not** enforce wall-clock execution windows.

### ControlPlaneService

Given `projectId` and `environment`, assembles `ProjectControlContext`:

- project
- active policy bundle
- resource budget profile
- capabilities enabled **and** allowed in that environment
- `resolvedAt`

It does not include repository state, evidence, or memory precedents.

## Implementations

Registries and admission ports are interfaces. Phase 1–2 ship in-memory adapters under
`src/infrastructure/` for tests and local development.

No database, no remote sync, no singleton global registry.

---

## Phase 2 — Objective admission and durable run initialization

Phase 2 establishes **admission authority and durable run identity**.
It does not establish repository truth, planning intelligence,
human approval, or execution authority.

### ObjectiveAdmissionService

Front door of the Orchestrator. Given an admission request it:

1. Validates the request (Zod; at least one acceptance criterion; positive integer `objectiveVersion`)
2. Resolves project control context via Phase 1 `ControlPlaneService`
3. Authorizes the requester (`RequesterAuthorizationService`)
4. Generates the idempotency key from `projectId`, `objectiveId`, `objectiveVersion`, `requestedEnvironment`
5. Computes `objectiveFingerprint` from canonical objective content
6. Checks the idempotency store
7. Same identity + same fingerprint → `ACTIVE_DUPLICATE` / `COMPLETED_DUPLICATE`
8. Same identity + different fingerprint → `OBJECTIVE_VERSION_CONFLICT`
9. Generates run/event/correlation/trace IDs
10. Reserves the idempotency key
11. Acquires an admission-scoped project lock
12. Creates the run in `RECEIVED`
13. Validates `RECEIVED → ADMITTED`
14. Persists `ADMITTED`
15. Appends `PROJECT_OBJECTIVE_SUBMITTED` to the event store
16. Binds the idempotency key to the `runId`
17. Releases the admission-scoped project lock
18. Returns `AdmissionResult`

A run is never ADMITTED before authorization, eligibility, idempotency, and lock succeed.
The successful path always releases the admission lock. Later planning/execution phases will acquire their own locks.

### RequesterAuthorizationService

Deterministic, explicit grants. Unknown requester, missing grant data, wrong project,
or wrong environment is denial. No OAuth, no IdP, no RBAC platform.

### IdempotencyStore

`getByKey` / `reserve` / `complete` / `markCompleted` / `release`.

Logical identity:

```text
projectId + objectiveId + objectiveVersion + requestedEnvironment
```

`requesterId` is not part of identity. Canonical objective content is hashed as `objectiveFingerprint`. For hashing only, `acceptanceCriteria`, `constraints`, and `nonGoals` are trimmed, de-duplicated, and sorted; stored Objective arrays are not mutated. `requestedOutcome` is hashed as submitted. Same identity and fingerprint is a duplicate. Same identity with a different fingerprint is `OBJECTIVE_VERSION_CONFLICT` — not a new run.

Duplicate keys never create a second run. `RESERVED` without a bound `runId` is fail-closed.

In-memory adapters do **not** provide distributed transactional guarantees.

Future durable implementations must atomically coordinate, or use an appropriate transactional/outbox pattern for:

- run persistence
- event persistence
- idempotency binding

They must also enforce `unique(key)` and atomic insert-if-absent reservation.

### ProjectLockService

Admission-scoped project lock (`acquire` / `release` / `getActiveLock`).
Same `runId` → `LOCK_ALREADY_OWNED`. Different run → `RESOURCE_CONFLICT`.
Lookup failure is never treated as an acquired lock.

The lock is held only for the admission transaction. Successful admission **releases** it before returning `ADMITTED`. Failures release it via compensation.

Later planning and execution phases will acquire their own locks. Phase 2 does not implement those locks.

The in-memory adapter is not distributed. Future stores must use compare-and-set.

### RunRepository

Persists run records. The state machine validates transitions; the repository stores results.
`create` / `getById` / `exists` / `save` / `listByProject`.

In-memory adapters do not provide distributed transactions. Future stores must atomically coordinate run persistence, event persistence, and idempotency binding (transaction or outbox).

### EventStore

In-memory append/list. No message queue. No external publish.
Successful admission writes one `PROJECT_OBJECTIVE_SUBMITTED` envelope.
Duplicates do not emit a second admission event.

### Duplicate behavior

- First request → `ADMITTED` (HTTP 201)
- Repeat while the run is active → `ACTIVE_DUPLICATE` with existing `runId` (HTTP 409)
- Repeat after the run is marked completed in the idempotency store → `COMPLETED_DUPLICATE` (HTTP 200)
- Same identity with different canonical content → `OBJECTIVE_VERSION_CONFLICT` (HTTP 409)

### Compensation

If a later step fails after reserve/lock/create:

- Unbound reservation is released
- Lock is released
- A created run is moved to `ADMISSION_REJECTED` (from `RECEIVED`) or `CANCELLED` (from `ADMITTED`)
- Compensation failure surfaces as `ADMISSION_COMPENSATION_FAILED`

### State progression

Admission uses only `RECEIVED → ADMITTED`.
`RECEIVED → EXECUTING` remains illegal.

### HTTP

`POST /v1/runs` delegates to `ObjectiveAdmissionService`. No business logic in the HTTP layer.

### Explicitly out of scope

LLM/GitHub/Discord/Slack/n8n integrations, shell execution, approval workflows,
policy evaluation engines, vector memory, CI orchestration, deployments,
repository indexing, and production databases.
