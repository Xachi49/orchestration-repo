# Phase 24 — Production synthesis, reference runtime & final system qualification

## Doctrine

```text
BUILD != RELEASE
RELEASE_CANDIDATE != RELEASE_QUALIFIED
RELEASE_QUALIFIED != DEPLOYED
CERTIFICATE != DEPLOYMENT_AUTHORIZATION
QUALIFICATION_RECORD != AUTHORITY_GRANT
RELEASE_MANIFEST != DEPLOYMENT
DEPLOYMENT != IN SCOPE
```

Phase 24 may determine whether a specific immutable release candidate is
coherent and qualified for release. It may **not** deploy that candidate,
grant authority, bypass governance, or manufacture operational permission.

There is **no Phase 25** in the core architecture.

## Macro flow

```text
SOURCE / COMMIT
    ↓
DETERMINISTIC BUILD
    ↓
RELEASE CANDIDATE IDENTITY
    ↓
REFERENCE RUNTIME MANIFEST
    ↓
PHASE 23 ASSURANCE AGAINST FINAL TARGET
    ↓
PRODUCTION READINESS CHECKS
    ↓
FULL-SYSTEM QUALIFICATION
    ↓
IMMUTABLE RELEASE QUALIFICATION RECORD
    ↓
RELEASE BUNDLE / MANIFEST
STOP
```

## Module

`src/qualification/` — release candidate, build/runtime manifests, readiness,
qualification runs/evidence/records, release manifests, lifecycle/recovery,
reference-runtime assembly over canonical stack services.

## Schema

Migration `019_phase24_production_synthesis`.

## Certificate binding

`RC.assuranceTargetFingerprint === SystemCertificate.targetFingerprint`

A Phase23 certificate produced against an 018/Phase23-only build **cannot**
qualify the final 019/Phase24 candidate. Fresh assurance against the final
target is required.
