# Production qualification runbook

## Purpose

Qualify an immutable release candidate. Do **not** deploy.

## Prerequisites

- Node 24 LTS
- PostgreSQL with migrations through `019_phase24_production_synthesis`
- Fresh Phase23 SystemCertificate for the **final** Phase24 assurance target
- Production configuration secrets present (hashed by presence only)

## Commands

```bash
npm run typecheck
npm test
npm run build
npm run reference-runtime:manifest
npm run qualify:preflight
```

`qualify:preflight` is a fail-closed **static** precheck only.
`PRECHECK_PASS != QUALIFIED_FOR_RELEASE`. It does not create a
`ReleaseQualificationRecord`, push, merge, deploy, grant roles, or approve runs.

Full `QUALIFIED_FOR_RELEASE` requires the Phase24 PostgreSQL acceptance suite
with trusted evidence and a fresh Phase23 certificate for the final target.

## Critical gates

- Candidate fingerprint integrity
- Exact Phase23 certificate target match + current VALID
- Schema / migration head = `SUPPORTED_SCHEMA_VERSION`
- PostgreSQL authoritative storage
- Fault injection disabled
- Reference-runtime manifest consistent
- Build artifact integrity
- Golden-path / restart / drain evidence
- Qualification creates zero operational authority

## Outcomes

- `QUALIFIED_FOR_RELEASE` — metadata only; **not deployed**
- `NOT_QUALIFIED` — critical FAIL
- `INCONCLUSIVE` — missing critical evidence

Historical qualification records are immutable. Drift changes **applicability**,
not history.
