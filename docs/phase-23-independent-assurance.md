# Phase 23 — Independent assurance, adversarial evaluation & system certification

## Doctrine

Assurance evaluates whether evidence supports a claim of conformance.
Assurance does **not** create authority, policy, execution, truth, or governance.

```text
ASSURANCE ≠ OPERATIONAL AUTHORITY
TEST PASS ≠ CERTIFICATE
CERTIFICATE ≠ EXECUTION AUTHORIZATION
CERTIFICATION ≠ DEPLOYMENT
ASSURANCE OPERATOR ≠ CERTIFIER
INCONCLUSIVE ≠ PASS
```

## Macro flow

```text
SYSTEM TARGET
    ↓
IMMUTABLE TARGET IDENTITY
    ↓
ASSURANCE PROFILE
    ↓
CONTROL / INVARIANT CATALOG
    ↓
BOUNDED CHALLENGE PLAN
    ↓
INDEPENDENT EVIDENCE COLLECTION
    ↓
DETERMINISTIC CONTROL EVALUATION
    ↓
FINDINGS
    ↓
ASSURANCE ASSESSMENT
    ↓
INDEPENDENT CERTIFIER
    ↓
SYSTEM CERTIFICATE
```

Never: `ASSURANCE PASS → APPROVED RUN`  
Never: `CERTIFICATE → AUTHORITY_GRANT`

## Roles

| Role | May | May not |
| --- | --- | --- |
| `ASSURANCE_OPERATOR` | initiate/operate bounded evaluations | certify, execute, govern |
| `ASSURANCE_CERTIFIER` | certify a QUALIFIED assessment | operational authority |

Default full certification requires independent principals (SoD).

## Evidence

Trusted evidence is created only by internal adapters (`recordTrustedEvidence`).
Public HTTP cannot upload `{ "result": "PASS" }` as trusted evidence.
Only `DIRECT` / `REPRODUCED` quality may satisfy required certification controls.

## Fault injection

Allowed only in `TEST` / `STAGING`.  
`PRODUCTION` + fault injection → `ASSURANCE_FAULT_INJECTION_DENIED` before mutation.

## Schema

Migration `018_phase23_independent_assurance`.
