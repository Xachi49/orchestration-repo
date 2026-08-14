# Architecture — Control Plane (Phase 1)

The Orchestrator Agent translates high-level objectives into evidence-grounded plans.
Phase 0 defined domain contracts and a fail-closed run-state machine.
Phase 1 adds **configuration authority**: the deterministic Control Plane.

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

Registries are ports. Phase 1 ships in-memory adapters under
`src/infrastructure/control-plane/` for tests and local development.

No database, no remote sync, no singleton global registry.

## Explicitly out of scope

LLM/GitHub/Discord/Slack/n8n integrations, shell execution, approval workflows,
policy evaluation engines, vector memory, CI orchestration, and deployments.
