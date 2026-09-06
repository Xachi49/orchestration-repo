# Phase 21 — Constitutional change control

Phase 21 governs **changes to institutional governance rules** established in
Phase 20. It answers: who may change governance rules, under which existing
rules, with what analysis, separation of duties, activation semantics, and audit
proof.

## Governing law

```text
CURRENT_CONSTITUTION
    AUTHORIZES
PROPOSED_CONSTITUTION
```

Never:

```text
PROPOSED_CONSTITUTION
    AUTHORIZES
ITSELF
```

All review and activation requirements for proposal P resolve against the
governance state **before** P becomes active.

## Domain module

`src/constitutional/` — proposals, typed change operations, safety floor,
fingerprints, impact analysis, review decisions, activation records, service,
repositories, tests.

Phase 20 (`src/governance/`) remains the institutional authority layer. Phase 21
consumes Phase 20.

## Lifecycle

| Status | Meaning |
|--------|---------|
| DRAFT | Mutable proposal draft |
| SUBMITTED | Material contents immutable |
| VALIDATED | Deterministic impact analysis recorded |
| AWAITING_REVIEW | Partial review quorum |
| AUTHORIZED | Review approved |
| STAGED | Activation scheduled |
| ACTIVATED | Governance mutation committed |
| REJECTED / CANCELLED / EXPIRED / STALE / FAILED | Terminal |

## Authority model

- **GOVERNANCE_ADMIN** — create/submit/analyze proposals; not reviewer/activator
- **CONSTITUTIONAL_REVIEWER** — phase-specific review decision (with institutional proof)
- **CONSTITUTIONAL_ACTIVATOR** — stage/activate (separate institutional proof)

Required:

```text
PHASE_SPECIFIC_CONSTITUTIONAL_AUTHORITY
AND
INSTITUTIONAL_REQUIREMENTS_SATISFIED
```

Never OR.

## Safety floor

Non-amendable invariants enforced in code (`assertConstitutionalSafetyFloor`).
Violations → `CONSTITUTIONAL_SAFETY_FLOOR_VIOLATION`. Not configurable via API
or database.

## Typed change DSL

Bounded operations only — no JSON Patch. Initial set includes mandate version
changes, quorum/SoD/scope changes, delegation limits, governance-admin scope,
organizational unit create/relationship/retire.

## Base governance fingerprint

`baseGovernanceFingerprint` binds proposal to material governance state at
creation. Activation requires `currentGovernanceFingerprint === baseGovernanceFingerprint`
or fails `CONSTITUTIONAL_BASE_STATE_STALE`.

## Impact analysis

Deterministic `ConstitutionalImpactAnalysis` classifies TIGHTENING / NEUTRAL /
RELAXING / STRUCTURAL. Does not authorize. Relaxing changes enforce stricter
separation (proposer ≠ reviewer ≠ activator).

## Review vs activation

- Review subject: `CONSTITUTIONAL_CHANGE_REVIEW` + exact proposal hash/version
- Activation subject: `CONSTITUTIONAL_CHANGE_ACTIVATION` + exact proposal hash/version
- Institutional proof ≠ constitutional approval ≠ activation

## Staged transactional activation

AUTHORIZED → STAGED → ACTIVATED with freshness re-checks. PostgreSQL transactions
via `withTransaction`. Idempotent activation per proposal identity.

## Phase 20 integration

When `institution.constitutionalControlEnabled`:

- Protected mutations (`createMandate`, `activateMandate`, `supersedeMandate`,
  `createOrganizationalUnit`) require internal `ConstitutionalActivationContext`
- No HTTP bypass flag

## PostgreSQL durability

Migration `016_phase21_constitutional_change_control.sql`:

- `constitutional_change_proposals`
- `constitutional_impact_analyses`
- `constitutional_review_decisions`
- `constitutional_activation_records`
- `constitutional_audit_events`
- extends `authority_grants` for `CONSTITUTIONAL_REVIEWER` / `CONSTITUTIONAL_ACTIVATOR`

## API

- `POST /v1/constitutional/changes`
- `GET /v1/constitutional/changes/:proposalId`
- `POST .../submit`, `/analyze`, `/review`, `/stage`, `/activate`

## Failure modes

| Code | Meaning |
|------|---------|
| `CONSTITUTIONAL_BASE_STATE_STALE` | Fingerprint drift |
| `CONSTITUTIONAL_SAFETY_FLOOR_VIOLATION` | Non-amendable invariant |
| `CONSTITUTIONAL_SELF_ESCALATION` | Principal conflict |
| `CONSTITUTIONAL_GOVERNANCE_LOCKOUT` | Would remove last admin path |
| `CONSTITUTIONAL_MUTATION_BYPASS_DENIED` | Direct Phase 20 mutation blocked |

## Reversal

After activation, recovery requires a **new** proposal. Historical lineage is
never deleted or silently rewritten.
