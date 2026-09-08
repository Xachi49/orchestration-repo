# Phase 22 — Governed federation

Phase 22 answers:

> How may independent institutions cooperate without merging, transferring,
> laundering, inheriting, or silently expanding authority?

## Governing law

Federation determines what independent institutions have mutually agreed may be
**REQUESTED** or **EXCHANGED**.

Each institution independently determines what is locally **AUTHORIZED**,
**ADMITTED**, **EXECUTABLE**, **VERIFIED**, and **REMEMBERED**.

## Doctrine

| Inequality | Meaning |
|---|---|
| `FEDERATION_AGREEMENT ≠ LOCAL_AUTHORITY` | Agreement coordinates; it does not authorize local ops |
| `REMOTE_APPROVAL ≠ LOCAL_AUTHORIZATION` | Foreign approval contributes zero local authority |
| `FEDERATED_ACCEPTANCE ≠ PHASE2_ADMISSION` | Accept ≠ admit |
| `FEDERATION_RESOURCE_LIMIT ≠ LOCAL_BUDGET_RESERVATION` | Request ceilings only |
| `FOREIGN_EVIDENCE ≠ LOCAL_TRUTH` | Receiving status remains `EXTERNAL_UNVERIFIED` |
| `A↔B + B↔C ≠ A↔C` | No transitive trust |
| `LOCAL_CONSTITUTION > FEDERATION_AGREEMENT` | Local governance always wins |

## Macro flow

```text
SOURCE INSTITUTION
    → FEDERATED WORK INTENT
    → AGREEMENT/SCOPE VALIDATION
    → TARGET INSTITUTION REVIEW/ACCEPTANCE
    → LOCAL REQUESTER AUTHORIZATION
    → PHASE 2 OBJECTIVE ADMISSION
    → EXISTING ORCHESTRATOR PIPELINE
```

Never: `SOURCE → DIRECT TARGET RUN`  
Never: `FEDERATION AGREEMENT → APPROVED`  
Never: `FEDERATION ACCEPTANCE → EXECUTION`

## Domain module

`src/federation/`

Authority roles (extend Phase 20 `authority_grants`, no second registry):

- `FEDERATION_NEGOTIATOR`
- `FEDERATION_RATIFIER`
- `FEDERATION_WORK_ACCEPTOR`
- `FEDERATION_EVIDENCE_SHARER`

Possessing any federation role creates **zero** execution authority.

## Activation transaction

Activation runs in one PostgreSQL transaction:

1. Lock participant institutions in **sorted** `institutionId` order (`pg_advisory_xact_lock`)
2. Reload agreement, recompute federation fingerprint, compare base
3. Reload and revalidate every ratification proof (exact Phase 20 provenance)
4. Activate agreement, persist activation record + audit, commit

Competing versions with the same base fingerprint: exactly one succeeds; loser
receives `FEDERATION_BASE_STATE_STALE`.

## Materialization boundary

Accepted federated intent → `ObjectiveAdmissionService.admit` with a genuine
**target-local** `requesterId`. Source cannot supply requester authority.

## Migration

`017_phase22_governed_federation`
