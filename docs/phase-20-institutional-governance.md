# Phase 20 — Governed institutional authority, delegation, quorum & separation of duties

## Doctrine

```text
IDENTITY != AUTHORITY
ROLE != AUTHORIZATION
AUTHORITY GRANT != BUSINESS DECISION
DELEGATION != AUTHORITY EXPANSION
QUORUM != BUSINESS APPROVAL
ATTESTATION != EXECUTION AUTHORIZATION
GOVERNANCE PROOF != PHASE-SPECIFIC DECISION
GOVERNANCE ADMIN != SUPERUSER
REVOCATION != HISTORY DELETION
EMERGENCY HOLD != NEW AUTHORITY
INSTITUTIONAL GOVERNANCE != PHASE 1 POLICY
```

**Institutional governance can constrain authority. It cannot manufacture
operational authority.**

## Authority law

```text
EffectiveAuthority ⊆ DelegatedAuthority ⊆ SourceAuthority ⊆ ExistingInstitutionalBoundary
```

Delegation is subtractive only. Cycles and unbounded depth are rejected.

## Integration formula

```text
PHASE_SPECIFIC_ROLE_AUTHORITY
AND
INSTITUTIONAL_REQUIREMENTS_SATISFIED
```

Never OR. Absent an applicable ACTIVE mandate, existing phase gates are unchanged.

## Pipeline

```text
DIRECT AUTHORITY
        ↓
OPTIONAL BOUNDED DELEGATION
        ↓
INSTITUTIONAL AUTHORITY RESOLUTION
        ↓
MANDATE CONDITIONS
        ↓
QUORUM + SEPARATION OF DUTIES
        ↓
INSTITUTIONAL AUTHORIZATION PROOF
        ↓
EXISTING PHASE-SPECIFIC AUTHORITY
        ↓
CANONICAL BUSINESS DECISION
```

## Proof is not business authorization

`InstitutionalAuthorizationProof` is only an additional prerequisite. It is not:

- AuthorizationRecord (Phase 6)
- Portfolio authorization (Phase 15)
- Experiment sponsorship (Phase 17)
- Strategy selection (Phase 16)
- Causal promotion (Phase 18)
- Decision Policy activation (Phase 19)
- Execution authority (Phase 7)

## Holds

Governance holds may BLOCK / PAUSE / CONTAIN. They cannot grant, approve,
execute, or delete history. Easy to stop; hard to start.

## Durability

Migration `015_phase20_institutional_governance.sql`. Production authority is
PostgreSQL-backed. In-memory repositories are test-only.
