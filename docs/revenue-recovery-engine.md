# Continuum Revenue — Revenue Recovery Engine

Product vertical on orchestrator Phases 0–24. **Not Phase 25.**

## Mission

Detect lead-response gaps → governed recovery objective → human-authorized
bounded outreach → measure engagement/appointment/sale → attribute recovered
revenue with exact lineage.

Core economic question: **How much previously-lost revenue did this system recover?**

## Doctrine

See `src/revenue-recovery/doctrine.ts`. Critical distinctions:

- RESPONSE GAP ≠ AUTHORIZATION TO CONTACT
- ESTIMATED ≠ BOOKED ≠ COLLECTED revenue
- CONTROL TOWER ≠ AUTHORITY
- RECOVERY ENGINE ≠ CRM SOURCE OF TRUTH

## MVP scope

Home-service / local-service oriented, multi-tenant (`customerAccountId` +
`projectId`). Lead sources: MANUAL | WEBHOOK | FAKE_TEST_SOURCE.

Messaging: **FakeRecoveryMessagingProvider only** — no Twilio/SendGrid/GHL.

CALLER ASSERTION != AUTHORIZATION. There is no product route that sends
outreach. Sends are reachable only through the canonical chain: Phase6
ApprovalRequest → HumanAuthorizationDecision → AuthorizationRecord → Phase7
ExecutionReadiness → preflight → SafeActuator →
`RevenueRecoveryPhase7Actuator` → `actuateRecoveryOutreachFromPhase7`. This
product does not mint AuthorizationRecords.

EVENT KIND != TRUST PROVENANCE. Trust provenance is server-assigned
(`FAKE_TEST` | `MANUAL_ATTESTATION` | `TRUSTED_CRM` |
`TRUSTED_PAYMENT_SOURCE`); generic HTTP ingest is always
`MANUAL_ATTESTATION`, which can only produce `ATTESTED_*` attributions.
`FAKE_TEST` is rejected outside the TEST runtime environment.

## API

- `POST /v1/revenue-recovery/config`
- `POST /v1/revenue-recovery/leads`
- `POST /v1/revenue-recovery/leads/:leadId/events`
- `POST /v1/revenue-recovery/leads/:leadId/detect-gap`
- `GET /v1/revenue-recovery/dashboard`
- `GET /v1/revenue-recovery/cases/:id`
- `POST /v1/revenue-recovery/cases/:id/prepare-objective`

Request bodies containing `humanAuthorizationConfirmed` or `trustProvenance`
are rejected with `CALLER_ASSERTION_REJECTED`.

## Control Tower

Routes:

- `/revenue-recovery`
- `/revenue-recovery/cases/:caseId`

Shows funnel metrics with estimated / booked / collected separated. Lead PII
masked.

## Migration

`021_product_revenue_recovery_integrity` (product migration; architectural phases stop at 24).

## Tests

Domain unit: `src/revenue-recovery/revenue-recovery.test.ts`

Product Postgres catalog (not in default unit gate):
`src/infrastructure/postgres/postgres.revenue-recovery.test.ts`
