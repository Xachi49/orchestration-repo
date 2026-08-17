# Architecture

The Orchestrator Agent translates high-level objectives into evidence-grounded plans.
Phase 0 defined domain contracts and a fail-closed run-state machine.
Phase 1 added **configuration authority**: the deterministic Control Plane.
Phase 2 added **admission authority**: objective admission and durable run identity.
Phase 3 added **verified repository truth**: an immutable, evidence-backed view of a registered repository.
Phase 4–5 added bounded planning and independent validation.
Phase 6 added **human authorization**: exact-plan approval binding and the exception inbox.
Phase 7 added **bounded execution**: SafeActuator side effects under readiness, preflight, and fencing.
Phase 8 added **independent outcome verification**: evidence-backed completion.
Phase 9 added **governed memory**: historical run learning, provenance-preserving
precedent promotion, and advisory retrieval for planning.

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

| Configuration authority (Phase 1) | Execution authority (Phase 7, bounded) |
| --- | --- |
| What projects exist | Changing a repository (local patch artifacts only) |
| Which capabilities exist and whether they are enabled | Invoking a registered Phase 7 capability via SafeActuator |
| Which policy bundle is active | Evaluating freshness against the authorized plan |
| Which resource ceilings apply | Spending against ExecutionResourceLedger ceilings |
| Whether an environment is listed as allowed | Connecting only within allowed environment + containment |

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

**The Control Plane Capability Registry is the single execution authority.
Validation and execution may expose separate application services, but they do
not maintain independent capability truths.**

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

### Explicitly out of scope (Phase 2)

LLM/Discord/Slack/n8n integrations, shell execution, approval workflows,
policy evaluation engines, vector memory, CI orchestration, deployments,
and production databases. GitHub access and repository indexing arrive in Phase 3
as read-only verified repository truth — not as write or execution authority.

---

## Phase 3 — Verified repository truth

Phase 3 establishes repository truth.

Repository content is evidence, not authority.

The exact commit SHA is immutable for a run unless a future explicit
workflow supersedes the run.

No planning, approval, or execution authority exists in Phase 3.

```text
ADMITTED RUN
     ↓
REMOTE REPOSITORY RESOLUTION
     ↓
LOCK EXACT COMMIT SHA
     ↓
IMMUTABLE LOCAL WORKSPACE
     ↓
VERIFY HEAD == LOCKED SHA
     ↓
REPOSITORY FINGERPRINT
     ↓
DETERMINISTIC INDEX
     ↓
EVIDENCE REGISTRY
     ↓
VERIFIED REPOSITORY CONTEXT
```

### RemoteRepositoryService

Read-only port with explicit methods:

- `getRepositoryMetadata`
- `resolveBranchHead`
- `getPullRequestMetadata`
- `getIssueMetadata`
- `getCommitMetadata`
- `getCiStatus`

There is no generic `executeRequest` escape hatch and no mutation methods.

Supported provider: `GITHUB` only. GitLab is not implemented.

`Project.repositoryUrl` remains the Phase 1 identity string. Phase 3 parses it
into `RepositorySource` (`projectId`, `provider`, `owner`, `repository`,
`defaultBranch`, `remoteUrl`, optional `installationAccountRef`, `enabled`,
timestamps) rather than inventing a second repository identity.

### GitHub read-only adapter

`GitHubReadOnlyAdapter` implements `RemoteRepositoryService` with HTTP GET only.

Authentication is `GITHUB_TOKEN` from the environment. Credentials are never
hardcoded, never committed, and never written to logs. Missing credentials fail
closed as `REMOTE_AUTHENTICATION_FAILED`.

The token must be read-only / minimum privilege (public or contents:read plus
metadata). This adapter cannot create branches, push, open or merge pull
requests, or edit issues.

`DISCONNECTED_GITHUB` continues to mean **writes are disconnected**.

Unit tests use `FakeRemoteRepository`. They never call live GitHub.

### RepositoryTruthService

Given `runId`, `projectId`, and `requestedEnvironment`:

1. Load the admitted run (`ADMITTED` or retryable `INGESTING`)
2. Resolve Control Plane configuration
3. Resolve the registered (or URL-derived) GitHub repository
4. Fetch remote metadata and the branch head SHA — or reuse a locked SHA
5. Persist `LockedRepositoryState`
6. Transition `ADMITTED → INGESTING` through the Phase 0 state machine
7. Prepare an immutable workspace and verify `HEAD == locked SHA`
8. Fingerprint and index (or reuse the composite index cache)
9. Persist evidence and a `VerifiedRepositoryContext` with `status: VERIFIED`
10. Mark the ingestion fence and locked repository state `VERIFIED`

It does not plan, fetch arbitrary web content, or transition to `PLANNING`.
Ingestion-complete is represented by `VerifiedRepositoryContext.status === VERIFIED`,
not a new lifecycle state. Concurrent ingestion is fenced by
`RepositoryIngestionCoordinator`.

### LockedRepositoryState

`runId`, `projectId`, `repositoryIdentity`, `branch`, `commitSha`, `lockedAt`,
`remoteSnapshotHash`, `status` (`LOCKED` | `VERIFIED` | `STALE` | `INVALID`).

A branch name is not repository identity. The exact commit SHA is the anchor.
Later ingestion on the same run must not silently replace that SHA with a newer
branch head. If the remote branch advances, that is drift.

### RepositoryWorkspaceService

Narrow filesystem/Git boundary:

- `prepareWorkspace`
- `fetchRemote`
- `checkoutDetachedCommit`
- `verifyHead`
- `removeWorkspace`
- `readFile` / `listFiles`

There is no `runCommand`. Git is invoked internally with argv arrays constructed
from validated metadata. Sequence:

```text
git fetch --prune
        ↓
resolve exact locked SHA
        ↓
detached checkout at SHA
        ↓
disable hooks (core.hooksPath)
        ↓
verify HEAD == locked SHA
```

Never `git pull`, merge, or rebase. Never check out an unverified user-controlled
ref. Workspace path: `{dataRoot}/runs/{runId}/workspace` (local equivalent of
`/app-data/runs/{runId}/workspace`).

Repository files are untrusted source material: hooks disabled, no install
scripts, no package-manager install, no repository-defined executables, no
dynamic evaluation, no path escape, binaries indexed as metadata only.

### RepositoryFingerprintService

Deterministic hash of:

- exact commit SHA
- lockfile path + content hashes
- relevant config / dependency-manifest path + content hashes
- file-tree manifest hash

Excluded: branch name, timestamps, absolute machine paths, mtime/inode, generated
paths such as `dist/` and `node_modules/`.

The same checked-out commit and relevant contents produce the same fingerprint.
A relevant content change or commit change changes the fingerprint.

### ProjectIndexer

Deterministic index (`indexVersion` `1.0.0`): file manifest, source entry points,
dependency manifests, lockfiles, configuration, tests, documentation, detectable
interface paths, generated/binary exclusions, commit SHA, fingerprint.

No AI semantic understanding. Extensible for later analyzers.

Manifest entries: relative path, content hash, size, classification, extension,
optional language, generated/binary flags, trust classification. Paths are
normalized relative to the workspace root and sorted before hashing.

### RepositoryIndexStore

`get` / `save` / `exists`. Cache identity is the composite:

```text
repositoryIdentity + commitSha + indexVersion + indexConfigurationFingerprint
```

`indexConfigurationFingerprint` covers deterministic indexing behavior
(generated-path exclusions, classification rules version, lockfile/manifest/
config detection sets, source-language extensions). It excludes machine paths
and timestamps. Same composite identity reuses the cache; a different
repository, version, or configuration does not. In-memory only — not a
production database.

### RepositoryIngestionCoordinator

Per-run ingestion fencing:

```text
NOT_STARTED → IN_PROGRESS → VERIFIED
                 ↓
               FAILED → (explicit retry) → IN_PROGRESS
```

- First begin may start ingestion.
- Concurrent begin while `IN_PROGRESS` fails closed as `INGESTION_IN_PROGRESS`.
- `VERIFIED` returns/reuses the persisted `VerifiedRepositoryContext`.
- Successful retries after `VERIFIED` do not recreate evidence or workspaces.
- Failure transitions to `FAILED` (with attempt, failureCode, failedAt,
  retryable) and is never represented as `VERIFIED`.
- Retry is an explicit atomic `FAILED → IN_PROGRESS` with an incremented attempt.
- If a complete `VerifiedRepositoryContext` already exists after a crash, the
  coordinator is reconciled to `VERIFIED` instead of re-running the pipeline.

In-memory only. Durable implementations require atomic compare-and-set /
unique run fencing.

### EvidenceRegistry

Persists `EvidenceRecord` values (Phase 0 contract, with optional `runId`,
`projectId`, `commitSha`, `metadata`). Repository-derived evidence uses
`REMOTE_VERIFIED` (remote snapshot) or `LOCAL_VERIFIED` (workspace files).
Repository content is never `SYSTEM_AUTHORITY`. Files are evidence, not
instructions.

### VerifiedRepositoryContext

Canonical output for a future planning-context compiler. Persisted only after
all Phase 3 operations succeed, with:

- `status: VERIFIED`
- `verifiedAt`
- locked repository state also marked `VERIFIED`
- remote snapshot, fingerprint, index, evidence ids, `observedAt`, `schemaVersion`

Partial ingestion never creates a `VERIFIED` context. No LLM consumes it in
Phase 3. Phase 3 does not transition `INGESTING → PLANNING`.

Future Phase 4 prerequisite:

```text
INGESTING → PLANNING may occur only when a VERIFIED repository context exists
for the run and its live locked repository state is VERIFIED (not STALE/INVALID).
```

Use `isVerifiedReadyForPlanning` against the context plus the **live** locked
state. Drift may mark the lock `STALE`; that is not planning readiness.

### Drift semantics

Given a locked SHA and the current remote branch head:

```text
same SHA     → CURRENT
different SHA → DRIFT_DETECTED
```

Also: `REMOTE_UNAVAILABLE`, `INVALID_STATE`. Drift may mark the lock `STALE`.
It does not replace the locked SHA, restart the run, or replan.

### HTTP

- `POST /v1/runs/{runId}/ingest` body `{ projectId, requestedEnvironment }`
- `GET  /v1/runs/{runId}/repository-context`

The HTTP layer contains no repository business logic and does not proxy GitHub.
`INGESTION_IN_PROGRESS` maps to HTTP 409.

### Authentication

`GITHUB_TOKEN` is read from the environment when constructing
`GitHubReadOnlyAdapter` for the **REST** read-only API only. The local
development stack uses fakes and does not require a token. Use a read-only,
minimum-privilege token if wiring the real adapter. Never commit tokens.

**Deferred:** private GitHub `git fetch` credential injection. Do not place
`GITHUB_TOKEN` in remote URLs, git configuration, command arguments, or logs.
Private clone/fetch auth is out of scope for Phase 3.

### Durability (future)

In-memory stores are not distributed. Future durable implementations must
provide:

- unique locked repository truth per run
- atomic compare-and-set / unique run fencing for ingestion coordination
- durable index caching keyed by repositoryIdentity + commitSha + indexVersion +
  indexConfigurationFingerprint
- safe concurrent workspace creation
- atomic evidence/context persistence
- cleanup/recovery of abandoned workspaces

Do not treat the current adapters as a production database.

---

## Phase 4 — Verified context compilation and planning

Phase 4 introduces the first probabilistic reasoning capability.

```text
The planning model proposes.

It does not establish repository truth.
It does not grant capabilities.
It does not interpret itself as policy authority.
It does not approve.
It does not execute.
```

```text
Phase 4 output = READY_FOR_VALIDATION candidate plan.

Phase 5 is responsible for independent validation,
policy/risk adjudication, REVISE/BLOCK/PASS/APPROVAL routing,
and bounded semantic revision.
```

### Flow

```text
INGESTING + VERIFIED context + VERIFIED live lock
  → PlanningReadinessService
  → PlanningCoordinator fence
  → INGESTING → PLANNING
  → ContextBudgetController + planningContextFingerprint
  → PlanningModel (Fake by default; optional OpenAI)
  → PlanProposal (not ExecutionPlan)
  → EvidenceReferenceValidator + CapabilityReferenceValidator
  → PlanCompiler + PlanHasher
  → DependencyGraphService + PlanResourceAnalyzer + PlanQualityScorer
  → PlanRepository READY_FOR_VALIDATION
  → PlanningCoordinator PLANNED
  → PLANNING → VALIDATING
```

### Resources

Phase 4 distinguishes two resource ledgers:

1. **Planning inference usage** (`PlanningUsageLedger`) — actual model calls
   made while generating the plan (gap analysis + proposal). Before each call
   the service computes a conservative token **reservation** =

   `compiledInputEstimate + configuredMaxOutputTokens`

   and atomically reserves against

   `remaining = maximumTotalTokens - completedActualTokens - activeReservedTokens`.

   Insufficient remaining capacity fails closed as `PLANNING_MODEL_BUDGET_EXCEEDED`
   without invoking the model. After the provider returns, the reservation is
   released and actual usage is charged (or the reservation is charged
   conservatively when usage is unavailable). Actual usage exceeding the
   reservation is recorded accurately and surfaces
   `PLANNING_MODEL_BUDGET_INVARIANT_VIOLATION`, blocking subsequent model calls.
   Call-limit exhaustion also fails as `PLANNING_MODEL_BUDGET_EXCEEDED`.
   Monetary cost is tracked only when deterministically available; otherwise
   deferred.

   The in-memory ledger provides process-local atomic reservation per `runId`.
   Durable implementations must use transactional or compare-and-swap
   reservation so concurrent planners cannot oversubscribe the run budget.

2. **Proposed plan resource estimate** (`PlanResourceAnalyzer`) — the model's
   estimated *future* execution consumption on the `PlanProposal`. Hard exceed
   fails Phase 4 as `PLAN_RESOURCE_BUDGET_EXCEEDED` and does not persist
   `READY_FOR_VALIDATION` or transition to `VALIDATING`.

Hard configured limits fail closed in Phase 4. Overrides are not implemented.
Phase 5 may classify explicitly overrideable resource/risk conditions as
`HUMAN_APPROVAL_REQUIRED`, but must never override a budget designated
hard / non-overrideable.

### Plan version

`planVersion` is a positive integer (`number`, int, `> 0`). Initial revision is
`1`, assigned by `PlanCompiler` (not the model). Phase 5 revisions increment
numerically and are capped at `3`. String `"1"`, semver, decimals, zero, and
negatives are rejected.

### Model boundary

`PlanningModel` has `toolsEnabled: false`. No shell, GitHub, file mutation,
approval, or policy authority. `FakePlanningModel` is the default local/test
adapter. `OpenAIPlanningModel` uses the OpenAI **Responses API** with schema-
constrained Structured Outputs (`responses.parse` + `zodTextFormat`) and is
opt-in via `OPENAI_API_KEY` / `OPENAI_MODEL`. It lives only under
`src/infrastructure/planning/`. No tools, web search, file search, code
interpreter, MCP, function calling, or `previous_response_id`. Tests and
`npm start` never call live OpenAI unless an explicit live model is injected.

Repository evidence is wrapped as `UNTRUSTED_PROJECT_DATA`. Prompt injection
inside repository text has no authority.

### Context fingerprint

`planningContextFingerprint` hashes objective fingerprint, policy bundle,
capabilities, budget profile id, repository fingerprint, locked commit SHA,
selected evidence ids/content hashes, and compiler/prompt versions. It excludes
timestamps and absolute machine paths.

### HTTP

- `POST /v1/runs/{runId}/plan`
- `GET  /v1/runs/{runId}/plan`
- `GET  /v1/runs/{runId}/planning-context` (metadata; no secrets)

---

## Phase 5 — Independent validation

Phase 5 adjudicates a candidate plan. It is an evaluator, not an approver.

```text
The validator evaluates.

It does not plan.
It does not approve.
It does not execute.
It does not grant capabilities.
It does not establish repository truth.
```

`ValidatorPort.authority` is `VALIDATE_ONLY`. `PASS` is **not** `APPROVED`.

The run-state machine structurally forbids `VALIDATING → APPROVED`. A terminal
Phase 5 `ValidationDecision` is data consumed by Phase 6; Phase 5 cannot
transition a run into `APPROVED`. The run remains in `VALIDATING` for every
Phase 5 outcome (`PASS`, `BLOCK`, `HUMAN_APPROVAL_REQUIRED`). Phase 6 may later
route `VALIDATING → AWAITING_APPROVAL` (or other Phase-6-owned edges).

### Flow

```text
VALIDATING + READY_FOR_VALIDATION plan
  → ValidationReadinessService
  → ValidationCoordinator fence (runId + planId + planVersion + planHash)
  → plan → UNDER_VALIDATION
  → DeterministicValidationService ladder
  → ValidationModel contextual assessment (advisory; skipped on hard violation)
  → ValidationDecisionEngine
  → PASS | BLOCK | HUMAN_APPROVAL_REQUIRED | REVISE
  → ValidationDecision persisted, fence DECIDED, plan status updated
  → run stays VALIDATING
```

### Deterministic ladder

Fixed order, structural gates first:

```text
SCHEMA → STATE → FRESHNESS → POLICY → CAPABILITY → DEPENDENCY → RESOURCE → SECURITY
```

`SCHEMA` re-parses the stored plan and recomputes the hash with
`Sha256PlanHasher`. `FRESHNESS` re-checks the live lock status, commit SHA,
repository fingerprint, and policy bundle id/hash. If a structural gate produces
an unrepairable blocking finding the ladder halts: the remaining validators
would be adjudicating a plan that is not grounded in current truth.

Validators return `ValidationFinding` records; they do not throw. Every finding
carries `blocking`, `repairable`, `approvalEligible`, and a deterministic
`semanticFingerprint`.

### Decision precedence

```text
1. blocking + !repairable + !approvalEligible        → BLOCK
2. blocking + !repairable + approvalEligible         → HUMAN_APPROVAL_REQUIRED
3. blocking + repairable
     a. fingerprint seen in an earlier attempt       → HUMAN_APPROVAL_REQUIRED
                                                       (REPEATED_SEMANTIC_VIOLATION)
     b. no revision attempts remaining               → HUMAN_APPROVAL_REQUIRED
                                                       (REVISION_ATTEMPTS_EXHAUSTED)
     c. otherwise                                    → REVISE
4. !blocking + approvalEligible                      → HUMAN_APPROVAL_REQUIRED
5. otherwise                                         → PASS
```

Policy `DENY`, hash mismatch, stale/invalid lock, rotated policy bundle, and a
hard budget exceed all land in case 1. They are never revised and never routed
to an approver. Only budget dimensions that are explicitly overrideable may
become `HUMAN_APPROVAL_REQUIRED`.

### Contextual assessment boundary

`ValidationModel` is separate from `PlanningModel` and has `toolsEnabled: false`.
It returns a `ContextualValidationAssessment`: a recommendation, confidence, and
observations. Its authority is bounded deterministically:

- A model `recommendation` field is never the authoritative `ValidationDecision`.
  `model says BLOCK` ≠ authoritative `BLOCK`.
- Structured observations become `ValidationFinding` records. Deterministic
  classification (severity → blocking; observation.repairable) feeds
  `ValidationDecisionEngine`. An unrepairable blocking contextual finding
  **may** therefore produce authoritative `BLOCK` via DecisionEngine precedence —
  that BLOCK comes from the engine, not from the recommendation field.
- A `BLOCK` recommendation with no supporting observation is recorded only as a
  non-blocking advisory `CONTEXTUAL_RECOMMENDATION` finding and changes nothing.
- Contextual assessment is skipped entirely when an unrepairable deterministic
  blocking violation already exists.

`FakeValidationModel` is the default local/test adapter.
`OpenAIValidationModel` (Responses API + `zodTextFormat`, no tools) is opt-in and
lives only under `src/infrastructure/validation/`.

### Inference categories and revision accounting

Phase 4–5 model consumption is categorized explicitly:

```text
INITIAL_PLANNING        → PlanningUsageLedger
CONTEXTUAL_VALIDATION   → ValidationUsageLedger (operation CONTEXTUAL_ASSESSMENT)
SEMANTIC_REVISION       → ValidationUsageLedger (operation PLAN_REVISION)
```

There is no dedicated Control Plane revision-token field. Revision inference
draws against the same hard `ResourceBudgetProfile` ceilings
(`maximumLlmCalls`, `maximumTotalTokens`) on `ValidationUsageLedger`, exposed as
the distinct `SEMANTIC_REVISION` sub-category. It cannot borrow unlimited
capacity from the planning ledger. Each revision record stores
`sourcePlanVersion`, `targetPlanVersion`, and `revisionAttempt`. Reservation
doctrine matches Phase 4 (reserve → call → settle actual / charge reservation
on ambiguous dispatch / release only on pre-dispatch failure). Insufficient
revision budget escalates to `HUMAN_APPROVAL_REQUIRED` with
`PlanningException` type `REVISION_BUDGET_EXCEEDED` rather than exceeding the
hard ceiling.

### Bounded semantic revision

```text
v1 → (REVISE) → v2 → (REVISE) → v3 → no v4
```

`MAX_SEMANTIC_REVISION_ATTEMPTS = 2`. A `REVISE` decision builds a
`RevisionEnvelope` that separates locked constraints (objective, success
definition, commit SHA, policy bundle, allowed action types, budget) from the
repairable findings to be addressed. `PlanRevisionModel` returns a
`PlanProposal`, never an `ExecutionPlan`: the revised proposal is re-validated
through the Phase 4 pipeline (`EvidenceReferenceValidator`,
`CapabilityReferenceValidator`, `DependencyGraphService`, `PlanResourceAnalyzer`,
`PlanQualityScorer`, `PlanCompiler`), so only `PlanCompiler` assigns a plan id,
version, and hash.

Each version gets its own fence and its own `ValidationDecision`; the superseded
version becomes `SUPERSEDED`. `ViolationFingerprintService` normalizes violations
deterministically (no embeddings, no similarity search), so a violation that
survives a revision is detected exactly and escalated instead of looping.
`REPEATED_SEMANTIC_VIOLATION` and `REVISION_ATTEMPTS_EXHAUSTED` both raise a
`PlanningException` recording where automated adjudication stopped.

### Plan status transitions

```text
READY_FOR_VALIDATION → UNDER_VALIDATION → VALIDATED_PASS
                                        → VALIDATED_BLOCK
                                        → VALIDATED_APPROVAL_REQUIRED
                                        → SUPERSEDED (revised)
```

### Fencing

`ValidationCoordinator` is keyed by `runId + planId + planVersion + planHash`
with `NOT_STARTED → IN_PROGRESS → DECIDED` and `FAILED` on error. A concurrent
call fails closed as `VALIDATION_IN_PROGRESS`. A `DECIDED` fence replays the
recorded decision, so validation is idempotent and cannot produce a second,
divergent verdict for the same artifact. In-memory adapters are process-local;
durable implementations must use atomic compare-and-set per plan identity.

### HTTP

- `POST /v1/runs/{runId}/validate`
- `GET  /v1/runs/{runId}/validation` (latest decision)
- `GET  /v1/runs/{runId}/validations` (decision history)
- `GET  /v1/runs/{runId}/validation-readiness`

---

## Phase 6 — Human authorization & exception inbox

Phase 6 consumes terminal Phase 5 decisions and determines whether an identified
human authorized an exact immutable plan. It does not execute.

```text
PASS != APPROVED
APPROVED != EXECUTED
Ordinary AI/model conversation is not a trusted authorization channel.
Only Phase 6 may transition AWAITING_APPROVAL → APPROVED.
VALIDATING → APPROVED remains illegal.
```

### Routing

```text
ValidationDecision = BLOCK
  → VALIDATING → BLOCKED
  → no ApprovalRequest

ValidationDecision = PASS | HUMAN_APPROVAL_REQUIRED
  → build ApprovalDecisionCard + decisionCardHash
  → persist ApprovalRequest
  → deliver via ApprovalDeliveryService
  → VALIDATING → AWAITING_APPROVAL
```

PASS still requires explicit human authorization before any future execution.

Preferred delivery sequence:

```text
persist request → store card → deliver → transition AWAITING_APPROVAL
```

If delivery fails: request is `CANCELLED` with `APPROVAL_DELIVERY_FAILED`, the
run stays `VALIDATING`, and an explicit retry creates a **new** ApprovalRequest
(new id, system-issued nonce, createdAt/expiresAt, decisionCardHash). The failed
request remains permanently CANCELLED for audit (`replacesApprovalRequestId` is
lineage only). Binding fields including `expiresAt` are immutable after creation.

### Exact approval binding

An approval binds to:

```text
projectId, objectiveId/version, planId/version/hash,
repositoryCommitSha/fingerprint, policyBundleHash,
validationDecisionId, approvalRequestId, decisionCardHash,
capabilitySetFingerprint,
approverId, decision, timestamps
```

**Human authorization binds not only to the exact plan but also to the exact
execution capability authority under which that plan was approved.**

Therefore:

```text
PLAN HASH MATCH
```

is necessary but not sufficient.

```text
PLAN HASH
+ REPOSITORY
+ POLICY
+ VALIDATION DECISION
+ CAPABILITY SET FINGERPRINT
```

must all remain identical.

Any material change invalidates approval. Plan v2 cannot authorize via a v1
request. Before `APPROVE`, Phase 6 rechecks plan hash, repository lock/freshness,
policy hash, **capability set fingerprint**, validation decision identity, card
hash, and expiry. Capability drift during review yields
`CAPABILITY_CHANGED_DURING_APPROVAL` (no AuthorizationRecord is created).

### Decision card

`ApprovalDecisionCard` is a compressed human-review artifact (what / why / where /
expected result / risk / blast radius / rollback / validation result / capability
authority scope). No hidden reasoning. `DecisionCardHasher` hashes authoritative
semantic content only, including system-derived `capabilitySetFingerprint` and
`capabilityAuthorityScope`. A capability authority change requires a new card,
new `decisionCardHash`, new `ApprovalRequest`, and a new human decision.

### Human decisions

```text
APPROVE → ApprovalRequest APPROVED, run AWAITING_APPROVAL → APPROVED
REJECT  → ApprovalRequest REJECTED, run → REJECTED
REQUEST_MODIFICATION → ModificationRequest persisted, request
                       MODIFICATION_REQUESTED, run → ESCALATED
```

`REQUEST_MODIFICATION` does not mutate the candidate plan and does not enter the
Phase 5 revision loop. A future explicit workflow must create new plan lineage.

### Replay, expiry, approvers

- System issues a cryptographically strong `decisionNonce` at ApprovalRequest
  creation; only the hash is stored. Plaintext is delivered out-of-band.
  Caller-invented nonces fail closed (`INVALID_DECISION_NONCE`). Reuse →
  `AUTHORIZATION_DECISION_REPLAYED`. Terminal/expired/cancelled/superseded
  requests invalidate the nonce.
- Default approval window: 24 hours (`DEFAULT_APPROVAL_WINDOW_MS`)
- `ApprovalExpiryService.expireDueRequests(now)` → request `EXPIRED`, run `EXPIRED`
- Expired approvals cannot be revived
- `ApproverAuthorizationService` checks `project.authorizedApproverIds`; unknown
  approver fails closed. Requester identity is not automatically an approver.

### Authorization record

Append-only `AuthorizationRecord` captures the immutable authorization event,
including the frozen `capabilitySetFingerprint` copied from the ApprovalRequest.
Corrections require a new record, never an edit.

### HTTP

- `POST /v1/runs/{runId}/authorization-route`
- `GET  /v1/runs/{runId}/approval-request`
- `GET  /v1/runs/{runId}/authorization-readiness`
- `POST /v1/approval-requests/{approvalRequestId}/decision`
- `GET  /v1/runs/{runId}/authorization`
- `POST /v1/approval-requests/expire`

Decision endpoints resolve binding from the stored `ApprovalRequest`. Callers
cannot supply an authoritative `planHash`.

---

## Phase 7 — Bounded execution & safe actuation

Phase 7 is the first controlled side-effect boundary. It executes only an exact,
human-authorized, still-fresh plan through a narrowly registered capability
surface. It has **no planning authority**, **no approval authority**, and **no
authority to invent new actions**.

```text
APPROVED != EXECUTED
EXECUTION_SUCCEEDED != VERIFIED_SUCCESS
APPROVED → EXECUTING   (Phase 7 owns)
VALIDATING → EXECUTING (illegal)
AWAITING_APPROVAL → EXECUTING (illegal)
Phase 7 does not transition to COMPLETED
```

### Flow

```text
APPROVED run
  + AuthorizationRecord (APPROVE)
  + immutable ExecutionPlan
      ↓
ExecutionReadinessService
      ↓
ExecutionCoordinator fence
      ↓
ExecutionPreflightService (freshness)
      ↓
DryRunCompiler → CompiledExecutionStep[]
      ↓
ExecutionAttempt + ExecutionAuthoritySnapshot
      ↓
APPROVED → EXECUTING
      ↓
sequential dependency-ordered SafeActuator steps
      ↓
ExecutionResult (run remains EXECUTING)
```

### Allowed actions

```text
CREATE_LOCAL_PATCH   — local patch artifact only (no commit/push/merge)
RUN_TESTS            — registered testProfileId → trusted argv (shell:false)
CREATE_TASK          — local/in-memory task representation
PREPARE_PULL_REQUEST — local PR metadata artifact (no GitHub write)
```

### Side-effect lifecycle

```text
RESERVED  → side-effect boundary NOT crossed (safe to continue / re-reserve)
RUNNING   → side-effect boundary MAY have been crossed (markRunning before SafeActuator)
SUCCEEDED | FAILED → terminal
```

If the process fails after `RUNNING` but before terminal persistence: do not blind
re-run; attempt actuator-specific reconciliation; otherwise
`STEP_EXECUTION_STATE_UNKNOWN` and contain (`EXECUTING → CONTAINED`).

### Rollback pipeline

Automatic rollback (max 1) executes only pre-authorized compensating steps already
in the approved plan, through the same bounded pipeline:

```text
authorized rollback definition
  → deterministic compilation
  → capability / argument / target validation
  → rollback idempotency key
  → reserve → markRunning → SafeActuator → persist → audit
```

No invented rollback commands. No generic rollback shell.

### Runtime / resources

Before each actuator: strictest of `capability.maximumRuntimeSeconds`, remaining
`maximumExecutionMinutes`, and registered test-profile timeout. Insufficient time
→ `EXECUTION_RESOURCE_BUDGET_EXCEEDED` without starting the actuator.

### Containment

When side-effect state is uncertain, rollback fails/is unsafe, or further automatic
action is prohibited: `EXECUTING → CONTAINED`. Normal actuator success leaves the run
`EXECUTING` for Phase 8 (not `COMPLETED`, not `VERIFIED_SUCCESS`).

### Key components

| Component | Role |
| --- | --- |
| `ExecutionReadinessService` | Gate: APPROVED + AuthorizationRecord + binding + VERIFIED lock + capabilities |
| `ExecutionPreflightService` | Immediate pre-actuation freshness; never silently reapproves |
| `ExecutionCoordinator` | Fence `NOT_STARTED→IN_PROGRESS→COMPLETED\|FAILED\|CONTAINED` keyed by run+plan+auth |
| `DryRunCompiler` | Plan → actuator instructions; rejects unsupported actions, shell, absolute paths |
| `CapabilityExecutionSchema` | Exact argument schemas per Phase 7 action |
| `ExecutionTargetValidator` | Path containment + protected targets (`.git`, `.env`, authority files) |
| `SafeActuator` | Narrow port: createLocalPatch / runRegisteredTestProfile / createLocalTask / preparePullRequestArtifact |
| `TestProfileRegistry` | TYPECHECK / UNIT_TESTS / BUILD → trusted argv + timeoutSeconds |
| `StepExecutionRepository` | RESERVED → RUNNING → SUCCEEDED\|FAILED; RUNNING re-entry → unknown |
| `ExecutionResourceLedger` | Runtime reservation + discrete budget ceilings before side effects |
| `RollbackService` | Max 1 automatic rollback; compensating-only steps excluded from happy path |
| `ContainmentResult` | Stop further automatic action; preserve artifacts; not success |
| `ExecutionService` | Orchestrates the full flow; success → EXECUTING; containment → CONTAINED |
| `ExecutionAuthoritySnapshot` | Exact authority at actuation time (incl. capabilitySetFingerprint) |

### Execution result statuses

```text
EXECUTION_SUCCEEDED  — actuators completed (not verified objective success)
EXECUTION_FAILED
EXECUTION_PARTIAL
EXECUTION_CONTAINED
```

### HTTP

- `POST /v1/runs/{runId}/execute`
- `GET  /v1/runs/{runId}/execution`
- `GET  /v1/runs/{runId}/execution-artifacts`

### Local stack

`createLocalExecutionStack` extends the Phase 6 authorization stack with
`FakeSafeActuator` (deterministic; no real npm spawn in unit tests). Artifacts
land under `dataRoot/runs/{runId}/artifacts/`. Tests that need executable plans
should use `createExecutionFriendlyPlanningModel()` because the default
`FakePlanningModel` emits `READ_FILE`, which Phase 7 dry-run rejects.

Capability fixtures passed as `capabilities` seed the **Control Plane**
`CapabilityRegistry` at admission. The same registry instance is used by
planning, validation, readiness, preflight, execution, and rollback-time
re-resolution. There is no separate validation-only capability truth.

`capabilitySetFingerprint` covers execution-authority fields only (including
`maximumRuntimeSeconds`, `approvalRequirement`, actions, environments, enabled,
and `version`). Descriptions and timestamps are excluded.

Phase 6 freezes the fingerprint onto the ApprovalRequest / decision card /
AuthorizationRecord. Phase 7 expected authority is
`AuthorizationRecord.capabilitySetFingerprint` — **not** a live recompute at
readiness. Live Control Plane fingerprint must equal that frozen value or
execution fails with `EXECUTION_CAPABILITY_CHANGED` (including at rollback
re-resolution). Fail closed; do not judge whether a change is "safe enough."

## Phase 8 — Independent outcome verification & evidence-backed completion

Phase 8 independently determines whether reality after execution satisfies the
authorized objective. The executor reports what it attempted; the verifier
measures what actually happened. Completion requires evidence.

### Governing invariants

```text
EXECUTION_SUCCEEDED  ≠  VERIFIED_SUCCESS
VERIFIED_SUCCESS     ≠  "the model thinks it worked"
COMPLETED            requires evidence-backed VERIFIED_SUCCESS + CompletionRecord
```

The executor cannot verify itself. Verification must not import SafeActuator,
PlanningModel, or ValidationModel implementations.

### Run-state semantics

```text
EXECUTING → VERIFYING → COMPLETED     (only when outcome = VERIFIED_SUCCESS)
VERIFYING → ESCALATED                 (PARTIAL_SUCCESS | VERIFICATION_FAILED | INCONCLUSIVE)
CONTAINED                             (may record verification; never → COMPLETED)
```

Illegal shortcuts (fail closed):

```text
EXECUTING → COMPLETED
VALIDATING → COMPLETED
APPROVED → COMPLETED
AWAITING_APPROVAL → COMPLETED
```

### Flow

```text
ExecutionResult + StepResults + Artifacts + AcceptanceCriteria
      ↓
VerificationReadinessService
      ↓
VerificationCoordinator fence (runId+executionAttemptId+planId+version+hash)
      ↓
EXECUTING → VERIFYING
      ↓
PostExecutionTruthService → PostExecutionSnapshot (+ hash)
      ↓
VerificationSpecificationCompiler
      ↓
DeterministicOutcomeVerificationService (ladder)
      ↓
optional VerificationModel (advisory; may downgrade only)
      ↓
OutcomeDecisionEngine
      ↓
OutcomeVerificationRecord
      ↓
VERIFIED_SUCCESS → CompletionRecord → COMPLETED
else → ESCALATED (or preserve CONTAINED)
```

### Historical authority vs current drift

**Historical execution authority** asks: was this actuation performed under the
exact human-authorized fingerprints at execution time?

```text
AuthorizationRecord.capabilitySetFingerprint
  == ExecutionAuthoritySnapshot.authorizedCapabilitySetFingerprint
  == ExecutionAuthoritySnapshot.liveCapabilitySetFingerprint
```

**Current Control Plane drift** (policy/capability changes after actuation) is
recorded separately (`CURRENT_DRIFT` findings). It must not rewrite whether the
already-observed execution was historically authorized. Future actions remain
subject to current authority.

### Evidence trust

| Trust class | May support VERIFIED_SUCCESS |
| --- | --- |
| `SYSTEM_OBSERVED` / `SYSTEM_RECOMPUTED` | Yes (deterministic) |
| `VERIFIED_EXECUTION_RECORD` | Yes (re-read stores) |
| `MODEL_INTERPRETATION` | No — may only challenge/downgrade |

Models must never create `SYSTEM_OBSERVED` or `SYSTEM_RECOMPUTED` evidence.
Missing evidence → `INCONCLUSIVE` (never default success).

### Deterministic ladder (order)

1. Binding / execution identity
2. Historical authority integrity
3. Side-effect state completeness
4. Artifact integrity (recompute hashes from disk)
5. Actual execution boundary
6. Governance / resource compliance
7. Step postconditions
8. Acceptance-criteria evidence coverage
9. Acceptance-criteria verdicts
10. Containment / unresolved uncertainty

### OutcomeDecisionEngine precedence

1. Contained / unresolved side-effect uncertainty → `CONTAINED`
2. Binding corruption / tampering / unauthorized effects / hard governance → `VERIFICATION_FAILED`
3. Required criterion `UNSATISFIED` → `PARTIAL_SUCCESS` if any satisfied, else `VERIFICATION_FAILED`
4. Any `PARTIALLY_SATISFIED` → `PARTIAL_SUCCESS`
5. Any `INCONCLUSIVE` / missing evidence → `INCONCLUSIVE`
6. Contextual structured concerns may downgrade only
7. `VERIFIED_SUCCESS` only when every required criterion and postcondition is
   `SATISFIED`, coverage complete, artifacts/authority/boundary/governance pass,
   and no success-blocking contextual finding

The model recommendation itself never causes step 7.

### Key components

| Component | Role |
| --- | --- |
| `VerificationReadinessService` | Gate: EXECUTING/CONTAINED + terminal ExecutionResult + bindings |
| `VerificationCoordinator` | Fence `NOT_STARTED→IN_PROGRESS→DECIDED\|FAILED` |
| `VerificationAttempt` | Append-only attempt metadata |
| `PostExecutionTruthService` | Reconstruct observable truth from stores (not ExecutionResult alone) |
| `PostExecutionSnapshotHasher` | Canonical hash; excludes timestamps/display/absolute paths |
| `VerificationEvidence` + repository | Append-only evidence with sourceType + trustClass |
| `ExecutionArtifactVerifier` | Recompute content hashes under `dataRoot` |
| `ActionOutcomeVerifierRegistry` | CREATE_LOCAL_PATCH / RUN_TESTS / CREATE_TASK / PREPARE_PULL_REQUEST |
| `ExecutionBoundaryVerifier` | Actual effects ⊆ authorized scope |
| `ExecutionGovernanceVerifier` | Phase 7 governance independently checked |
| `VerificationSpecificationCompiler` | Objective criteria + plan postconditions; stable criterion IDs |
| `VerificationCoverageService` | Every criterion represented; gaps → INCONCLUSIVE |
| `DeterministicOutcomeVerificationService` | Ladder above |
| `VerificationModel` / `FakeVerificationModel` | Contextual assessment; default fake; no tools |
| `VerificationInferenceLedger` | Separate from planning/validation inference |
| `OutcomeDecisionEngine` | Authoritative verdict |
| `OutcomeVerificationRecord` | Append-only decision record |
| `CompletionRecord` | ONLY for VERIFIED_SUCCESS; proves COMPLETED |
| `OutcomeVerificationService` | Orchestrates the full flow; no remediation |

Acceptance criteria are not mapped to execution evidence heuristically for
completion authority. Every criterion must have an explicit verification
binding inside the hashed, validated, human-authorized ExecutionPlan.

```text
HEURISTIC_RELEVANCE ≠ VERIFICATION_BINDING
THE HUMAN AUTHORIZES BOTH THE ACTION AND THE DEFINITION OF PROOF.
```

Criterion IDs are assigned by shared `AcceptanceCriterionIdentityService`
(objectiveFingerprint + ordinal + normalized text) used by Phases 4–8.
`AcceptanceCriterionVerificationBinding` participates in `planHash`.
Altering a binding requires a new plan → revalidation → new authorization.

Keyword/actionType matching may appear only as a non-authoritative diagnostic
suggestion. It must never create `SYSTEM_OBSERVED` evidence and must never
cause `SATISFIED`, `VERIFIED_SUCCESS`, or `COMPLETED`.

### No remediation

For non-success outcomes Phase 8 must not re-execute, replan, revise, expand
scope, request capabilities, or self-authorize remediation.

### HTTP

- `POST /v1/runs/{runId}/verify`
- `GET  /v1/runs/{runId}/verification`
- `GET  /v1/runs/{runId}/verification-evidence`

No `/mark-success`, `/complete`, or `/override-verification`.

### Local stack

`createLocalVerificationStack` extends `createLocalExecutionStack` with
`FakeVerificationModel`, in-memory evidence/outcome/completion stores, and
verification readiness/coordinator. Tests that need executable plans should
continue to use `createExecutionFriendlyPlanningModel()` with acceptance
criteria aligned to plan postconditions.

---

## Phase 9 — Governed memory, learning ledger & precedent promotion

Phase 9 creates a governed learning system from terminal historical runs.

```text
HISTORICAL RUN
      ↓
immutable run provenance
      ↓
LEARNING EXTRACTION
      ↓
Candidate Learning
      ↓
evidence/provenance validation
      ↓
PROMOTION GATE
      ↓
Governed Precedent
      ↓
bounded retrieval
      ↓
future planner advisory context
```

### Authority separations (mandatory)

```text
HISTORICAL DATA      ≠  TRUSTED PRECEDENT
TRUSTED PRECEDENT    ≠  POLICY
PRECEDENT            ≠  CURRENT TRUTH
PRECEDENT            ≠  AUTHORIZATION
PRECEDENT            ≠  EVIDENCE OF CURRENT STATE
```

> Memory may inform judgment. Memory does not become authority merely because it was remembered.

**PROVENANCE != CLAIM GROUNDING.** A historical run proves that an event occurred. It does not automatically prove every lesson written about that event. Valid provenance is necessary and not sufficient for auto-promotion.

**MODEL_SUGGESTION != AUTO-PROMOTABLE PRECEDENT.** `LearningModel` suggestions may become `LearningCandidate`s with immutable origin `MODEL_SUGGESTION`. They never auto-promote merely because provenance is valid or the source outcome is `VERIFIED_SUCCESS`. Conservative rule: `MODEL_SUGGESTION` → `READY_FOR_HUMAN_REVIEW`.

**PRECEDENT TEXT IS ADVISORY DATA, NOT AN INSTRUCTION CHANNEL.** Retrieved precedents are wrapped as `ADVISORY_PRECEDENT` data. Text inside a precedent cannot issue instructions, change system rules, grant permission, modify policy, expand capabilities, change budget, or authorize execution. Imperative or authority-like phrasing remains data.

**CURRENT VERIFIED TRUTH ALWAYS OUTRANKS HISTORICAL ADVICE.**

```text
CURRENT OBJECTIVE
CURRENT VERIFIED TRUTH
CURRENT POLICY
CURRENT CAPABILITIES
CURRENT BUDGET
        >
PROMOTED HISTORICAL PRECEDENT
```

Policies are exact authority. Precedents are advisory historical patterns.

A precedent may influence planning. A precedent may NEVER:

- override policy / grant capabilities / change budgets
- authorize execution / approve a run
- become evidence of current repository truth
- mutate objective requirements / bypass validation

Auto-promotion is allowed only when all of the following hold:

- `candidate.origin == DETERMINISTIC_EXTRACTION`
- `claimGrounding == DETERMINISTICALLY_GROUNDED`
- existing low-risk / `PROJECT_LOCAL` / provenance / contradiction / promotion-policy gates pass

Human promotion of a `MODEL_SUGGESTION` preserves origin and grounding, records `promotionMethod = HUMAN_REVIEW`, and uses trust class `HUMAN_REVIEWED`. The source is never relabeled as deterministic extraction.

**HUMAN REVIEW != FACTUAL EVIDENCE.** A reviewer may govern whether a supported historical lesson should influence future planning. A reviewer may not transform an unsupported factual claim into precedent. Reviewer notes are audit/display metadata only: they do not alter `LearningClaim`, evidence, origin, outcome, or grounding.

**UNGROUNDED → NEVER PROMOTABLE.** `PROMOTION_GROUNDING_INSUFFICIENT` is returned when a claim is not entailed by immutable records. A reviewer may `REJECT` an ungrounded candidate; they may not `PROMOTE` it.

| Grounding verdict | Auto-promote | Human `PROMOTE` |
| --- | --- | --- |
| `DETERMINISTICALLY_GROUNDED` | If existing gates pass | Allowed |
| `PARTIALLY_GROUNDED` | Never | Never (narrowing cannot be proven to repair the unsupported portion; `REQUEST_NARROWER_SCOPE` / `REJECT` only) |
| `REQUIRES_HUMAN_REVIEW` | Never | Allowed when structured facts and provenance exist |
| `UNGROUNDED` | Never | Never |

`HUMAN_REVIEWED` describes governance of a supported claim, not a bypass around claim grounding. `PrecedentIntegrityService` fail-closes on `HUMAN_REVIEW` + `UNGROUNDED` even if hashes were recomputed. Ungrounded candidates remain in the historical candidate repository for audit and do not count toward corroboration, trust upgrades, contradiction resolution, or supersession authority.

### Key components

| Component | Role |
| --- | --- |
| `HistoricalRunRecord` | Immutable provenance anchor over Phase 0–8 outputs |
| `HistoricalRunRecordHasher` | Canonical hash of authority identities (no display/timestamps) |
| `LearningCandidate` | Descriptive advisory lesson with immutable `origin` and structured `LearningClaim`; never `POLICY_RULE` |
| `LearningClaim` / `LearningClaimGroundingService` | Bounded semantic facts; promotion evaluates the claim, not prose. Verdicts: `DETERMINISTICALLY_GROUNDED` / `PARTIALLY_GROUNDED` / `UNGROUNDED` / `REQUIRES_HUMAN_REVIEW` |
| `LearningExtractionService` | Deterministic candidate extraction; constructs the structured claim first, then renders `statement` |
| `LearningModel` / `FakeLearningModel` | Optional contextual suggestions persisted as `MODEL_SUGGESTION`; never promotes |
| `PrecedentProvenance` | Exact source identities + `provenanceHash` |
| `PrecedentApplicability` | Scope envelope; default `PROJECT_LOCAL` |
| `PrecedentPromotionPolicy` | Conservative memory promotion metadata (not Control Plane policy) |
| `PrecedentPromotionReadinessService` | Deterministic eligibility gate |
| `PrecedentPromotionDecision` | Human review contract (separate from Phase 6 auth) |
| `PromotedPrecedent` | Versioned advisory precedent; trust never `AUTHORITATIVE` |
| `LearningLedger` | Append-only audit events |
| `PrecedentContradictionService` | OPEN contradictions; no silent delete |
| `PrecedentSupersession` | ACTIVE→SUPERSEDED with new version referencing old |
| `PrecedentRetriever` | Exact filters then deterministic top-K ranking |
| `PrecedentIntegrityService` | Tamper / poison defense (`PRECEDENT_INTEGRITY_FAILED`) |
| `PrecedentCorroborationService` | Independent-run corroboration; same run not double-counted |
| `GovernedMemoryService` | Orchestrates learn → extract → promote → ledger |
| `LearningCoordinator` | Fence `NOT_STARTED→IN_PROGRESS→PROCESSED\|FAILED` |

### Promotion authority

- Deterministic auto-promote ONLY: `DETERMINISTIC_EXTRACTION` + `DETERMINISTICALLY_GROUNDED` + `PROJECT_LOCAL` + low-risk + eligible outcome + complete provenance + no hard contradiction
- `MODEL_SUGGESTION` never auto-promotes; valid provenance is not claim grounding
- `GLOBAL` / high-risk / security / policy-like → human `PrecedentPromotionDecision` only
- Human review does not erase origin. Audit payload records origin, grounding verdict, and promotion method.
- Human review does not create facts. `HUMAN_REVIEWED` is not a grounding bypass.
- `UNGROUNDED` is never promotable (`PROMOTION_GROUNDING_INSUFFICIENT`)
- `LearningModel` NEVER promotes
- Callers cannot POST a `PromotedPrecedent` directly
- `PrecedentIntegrityService` fail-closes on `promotionMethod = AUTO_PROMOTE` sourced from `MODEL_SUGGESTION`
- Contradiction comparison uses structured claim identity/polarity, not prose wording

### Outcome quality gating

| Outcome | Eligible learning |
| --- | --- |
| `VERIFIED_SUCCESS` | `SUCCESS_PATTERN` and related positive patterns |
| `PARTIAL_SUCCESS` | Bounded failure/verification; never full success claim |
| `INCONCLUSIVE` | Evidence-gap only; never success |
| `CONTAINED` | Containment / safety patterns |
| `BLOCKED` / `REJECTED` / `EXPIRED` / `ESCALATED` | Process / governance patterns |

Terminal learnable run states: `COMPLETED`, `BLOCKED`, `REJECTED`, `EXPIRED`, `ESCALATED`, `CONTAINED`.

### Planning integration

Retrieval order in planning prompts:

1. Immutable system contract
2. Control plane / policies / capabilities / budgets
3. Objective
4. Verified current repository truth
5. **Advisory promoted precedents** (`ADVISORY_PRECEDENT`)
6. Other untrusted project data

`planningContextFingerprint` includes retrieved precedent IDs, versions, and hashes (sorted). Precedent drift alone does not invalidate authorization — precedents are advisory, not authority.

### HTTP

- `POST /v1/runs/{runId}/learn`
- `GET  /v1/runs/{runId}/learnings`
- `GET  /v1/projects/{projectId}/precedents`
- `GET  /v1/precedents/{precedentId}`
- `POST /v1/precedent-candidates/{candidateId}/review`

No `POST /v1/memory` with arbitrary trusted text.
No direct `PromotedPrecedent` creation.

### Local stack

`createLocalMemoryStack` extends `createLocalVerificationStack` with
`FakeLearningModel`, append-only in-memory memory repositories, learning
coordinator, and `GovernedMemoryService`. Planning is bound to
`PrecedentRetriever` for advisory context.


