# Revenue Recovery Engine — Agent Handoff

## Repository

* repository: orchestration-repo
* current branch: `product/revenue-recovery-engine`
* current work is **uncommitted** and **unpushed**
* workspace path (local): `/Users/a--/orchestration-repo`

### Working tree snapshot (at handoff write time)

**Modified:**

* `apps/control-tower/src/api/control-tower-api.ts`
* `apps/control-tower/src/app/AppRoutes.tsx`
* `apps/control-tower/src/app/AppShell.tsx`
* `apps/control-tower/src/components/ui.test.tsx`
* `scripts/qualify-preflight.mjs`
* `src/api/server.ts`
* `src/domain/durability/index.ts`
* `src/infrastructure/postgres/migrate.test.ts`
* `src/infrastructure/postgres/postgres.migrate.test.ts`
* `src/infrastructure/postgres/postgres.phase23.test.ts`
* `src/infrastructure/postgres/postgres.phase24.test.ts`
* `src/infrastructure/postgres/stack.ts`
* `src/qualification/qualification.test.ts`
* `src/runtime/process.ts`

**Untracked:**

* `apps/control-tower/src/features/revenue-recovery/`
* `docs/revenue-recovery-engine.md`
* `docs/revenue-recovery-operations.md`
* `docs/agent-handoff-revenue-recovery.md` (this file)
* `migrations/020_product_revenue_recovery.sql`
* `src/api/revenue-recovery-factory.ts`
* `src/api/revenue-recovery.ts`
* `src/infrastructure/postgres/postgres.revenue-recovery.helpers.ts`
* `src/infrastructure/postgres/postgres.revenue-recovery.test.ts`
* `src/infrastructure/postgres/repositories/revenue-recovery.ts`
* `src/revenue-recovery/`

## Platform State

* Orchestrator Core **Phases 0–24 are complete and sealed**
* **There is no Phase 25** — do not create one; do not rename product work as Phase 25
* New work is **product / vertical** work on top of the core platform
* **Control Tower MVP** is already completed / merged (prior product branch)
* **PostgreSQL** is the authoritative persistence layer
* **Accumulated database history is intentional and must be preserved**
* Do **not** reset, truncate, drop, or clean the PostgreSQL database

## Product

* **Continuum Revenue — Revenue Recovery Engine**
* Purpose: detect lead response gaps → create governed recovery objectives → execute **bounded** recovery actions (fake only) → attribute recovered appointments/revenue with exact lineage
* **Fake messaging only** (`FakeRecoveryMessagingProvider`)
* **No** real SMS / email / CRM / payment provider actions
* **No** deployment
* Product docs:
  * `docs/revenue-recovery-engine.md`
  * `docs/revenue-recovery-operations.md`

Core economic question: **How much previously-lost revenue did this system recover?**

## Current Product Architecture

### Domain module — `src/revenue-recovery/`

| File | Role |
| --- | --- |
| `doctrine.ts` | Product laws + absolute safety ceilings |
| `errors.ts` | `RevenueRecoveryError` + codes |
| `hash.ts` | Canonical hashing + PII masking helpers |
| `lead.ts` / `lead-source.ts` | Lead ingest + source kinds |
| `recovery-event.ts` | LeadEvent kinds + append model |
| `recovery-config.ts` | Versioned RecoveryConfiguration + contact windows / TZ |
| `response-gap.ts` | Deterministic gap detector + gap identity |
| `recovery-case.ts` | RecoveryCase lifecycle |
| `contact-policy.ts` | ContactPolicyEvaluator (fail closed) |
| `objective-mapping.ts` | Map case → Phase2 AdmissionRequest + planning context |
| `recovery-action.ts` | Bounded action schemas |
| `recovery-template.ts` | Message templates + variable substitution |
| `messaging.ts` | `RecoveryMessagingProvider` + Fake provider |
| `recovery-attempt.ts` | RecoveryAttempt records |
| `recovery-outcome.ts` | Deterministic outcome evaluation |
| `revenue-attribution.ts` | Attribution types / confidence / window |
| `recovery-record.ts` | Immutable hashed RevenueRecoveryRecord |
| `audit.ts` | Product observation events (not authority) |
| `repositories.ts` | Port interfaces |
| `memory-repositories.ts` | In-memory implementations |
| `service.ts` | `RevenueRecoveryService` orchestration |
| `index.ts` | Barrel |
| `revenue-recovery.test.ts` | Domain unit tests |

### API

* `src/api/revenue-recovery.ts` — Fastify route registration
* `src/api/revenue-recovery-factory.ts` — memory + Postgres service factories
* Wired in `src/api/server.ts` when `deps.revenueRecovery` is present

**Routes:**

* `POST /v1/revenue-recovery/config`
* `POST /v1/revenue-recovery/leads`
* `POST /v1/revenue-recovery/leads/:leadId/events`
* `POST /v1/revenue-recovery/leads/:leadId/detect-gap`
* `GET /v1/revenue-recovery/dashboard`
* `GET /v1/revenue-recovery/cases/:recoveryCaseId`
* `POST /v1/revenue-recovery/cases/:recoveryCaseId/prepare-objective`
* `POST /v1/revenue-recovery/cases/:recoveryCaseId/authorized-action` ⚠️ **integrity risk — see below**

### PostgreSQL

* `migrations/020_product_revenue_recovery.sql`
* `src/infrastructure/postgres/repositories/revenue-recovery.ts`
* `src/infrastructure/postgres/postgres.revenue-recovery.helpers.ts`
* `src/infrastructure/postgres/postgres.revenue-recovery.test.ts` (scenario catalog; excluded from default `npm test`)
* Stack wiring: `src/infrastructure/postgres/stack.ts` exports `revenueRecoveryService`
* Runtime wiring: `src/runtime/process.ts` passes `revenueRecovery: postgres.revenueRecoveryService` into `buildServer`

### Control Tower

* Pages: `apps/control-tower/src/features/revenue-recovery/RevenueRecoveryPages.tsx`
* Routes: `/revenue-recovery`, `/revenue-recovery/cases`, `/revenue-recovery/cases/:recoveryCaseId`
* Nav + API client updates in AppShell / AppRoutes / `control-tower-api.ts`
* Shows funnel + **estimated / booked / collected** as separate numbers; lead PII masked

### Schema version pins updated for 020

* `src/domain/durability/index.ts` → `SUPPORTED_SCHEMA_VERSION = "020_product_revenue_recovery"`
* migrate tests, phase23/24 schema continuity tests, qualification pin, `scripts/qualify-preflight.mjs`

## Current Domain Capabilities

Implemented (first pass / MVP):

1. **Lead model** — durable lead with `customerAccountId`, `projectId`, source identity, material fingerprint, optional PII, consent metadata
2. **Lead idempotency** — same `(customerAccountId, source, externalLeadId)` → same Lead; material conflict → `LEAD_SOURCE_CONFLICT`
3. **Response-gap detection** — deterministic threshold elapsed + no qualifying human response; gap ≠ authorization
4. **RecoveryCase** — durable case with gap identity; statuses include OPEN / IN_ORCHESTRATION / ENGAGED / APPOINTMENT_BOOKED / CONVERTED / SUPPRESSED / …
5. **RecoveryConfiguration** — versioned tenant/project config + fingerprint; ceilings cannot exceed code safety caps
6. **ContactPolicyEvaluator** — DNC, consent, channel presence, windows (IANA TZ), cooldown, attempt limits
7. **Objective mapping** — maps into canonical Phase2 `AdmissionRequest`; optional admit via `ObjectiveAdmissionService`
8. **Bounded recovery action schemas** — SMS / email / callback task / wait / exhaust; recipient must match lead
9. **Fake messaging provider** — SIMULATED delivery only; no external network sends
10. **RecoveryAttempt** — durable attempt records with masked recipient refs
11. **Inbound lead events** — append-only LeadEvents with source/idempotency identity
12. **Suppression** — DNC / consent revoked → case SUPPRESSED; outreach denied
13. **Deterministic RecoveryOutcome** — from authoritative events, not model judgment
14. **RevenueAttribution** — ESTIMATED / CONFIRMED_SALE / CONFIRMED_PAYMENT + attribution window
15. **RevenueRecoveryRecord** — immutable hashed economic record (does not replace CompletionRecord)
16. **Tenant/project isolation** — service asserts matching `customerAccountId` + `projectId`
17. **Control Tower economic views** — dashboard funnel + case detail with separated revenue classes

## Current Schema

* Migration head: **`020_product_revenue_recovery`**
* Migration 020 is a **product** migration, **not Phase 25**
* `SUPPORTED_SCHEMA_VERSION` has been updated to `020_product_revenue_recovery`
* Tables include: leads, lead_events, config, cases, templates, attempts, attributions, records, audit_events

## Current Test Baseline

Recorded at last successful gate run on this branch (before this handoff-only doc write):

* server unit: **852/852 PASS**
* frontend tests: **5/5 PASS**
* server typecheck: **PASS**
* server build: **PASS**
* frontend build: **PASS**

Default unit command excludes `src/infrastructure/postgres/postgres.*.test.ts` (so product Postgres acceptance is not in the 852 count).

## PostgreSQL Acceptance Status

* Revenue Recovery Postgres scenarios **A–O** are present in helpers/catalog
* Economic headline scenario (`ECONOMIC_HEADLINE_4800`) is present
* They have **NOT** yet been executed as the qualification gate
* **Do not** run the full accumulated-Postgres qualification until the current **integrity closure** is complete
* **Do not** reset/truncate/drop the accumulated database

## Critical Core Doctrine

Preserve permanently:

> AI may determine what could be useful.  
> Deterministic systems determine what is true, permitted, affordable, authorized, executable, successful, and worthy of being remembered.

Also preserve:

```text
PASS != APPROVED
APPROVED != EXECUTED
EXECUTION_SUCCEEDED != VERIFIED_SUCCESS
VERIFIED_SUCCESS != COMPLETED
SCHEDULING != AUTHORITY
CONTROL TOWER != AUTHORITY
CALLER ASSERTION != AUTHORIZATION
BOOLEAN TRUE != AUTHORIZATION RECORD
RESPONSE GAP != AUTHORIZATION TO CONTACT
CONTACTABLE != AUTHORIZED ACTION
OUTREACH SENT != LEAD ENGAGED
LEAD ENGAGED != APPOINTMENT
APPOINTMENT != REVENUE
REVENUE CLAIM != ATTRIBUTED REVENUE
ATTRIBUTED REVENUE != CASH COLLECTED
```

Product-specific:

```text
ESTIMATED != CONFIRMED_SALE != CONFIRMED_PAYMENT
RECOVERY ENGINE != CRM SOURCE OF TRUTH
MODEL SUGGESTION != CONTACT CONSENT
```

## Current Integrity Closure

The **next task** is to close two boundaries **before** running product Postgres qualification.

### 1. Authorization Provenance

**Problem (current code):**

* Route: `POST /v1/revenue-recovery/cases/:recoveryCaseId/authorized-action`
* Body accepts `humanAuthorizationConfirmed: z.literal(true)`
* Service `executeAuthorizedRecoveryAction` treats that boolean as the gate

This is **caller assertion**, not Phase6 authority.

**Required law:**

```text
CALLER ASSERTION != AUTHORIZATION
BOOLEAN TRUE != AUTHORIZATION RECORD
```

Recovery external actions must derive from the canonical chain:

```text
Phase6 ApprovalRequest
→ HumanAuthorizationDecision
→ AuthorizationRecord
→ Phase7 ExecutionReadiness
→ Phase7 preflight
→ SafeActuator
→ Revenue Recovery domain actuator
```

The Revenue Recovery product must **not** manufacture authorization.

**Audit carefully:**

* `src/api/revenue-recovery.ts` (`authorized-action`)
* `src/revenue-recovery/service.ts` (`executeAuthorizedRecoveryAction`)
* Any path where UI/API can force outreach without a durable AuthorizationRecord

Caller-supplied booleans or IDs must **not** be trusted as authority. Prove run/case binding from **persisted** authorization + execution readiness.

### 2. Economic Provenance

**Problem (current code):**

* `POST /v1/revenue-recovery/leads/:leadId/events` accepts `SALE_RECORDED` / `PAYMENT_RECORDED`
* `attributeFromEvent` can mint `CONFIRMED_SALE` / `CONFIRMED_PAYMENT` from those events

A caller-supplied event type must **not** automatically create confirmed economic truth.

**Introduce/clarify provenance classes**, e.g.:

* `FAKE_TEST`
* `MANUAL_ATTESTATION`
* `TRUSTED_CRM`
* `TRUSTED_PAYMENT_SOURCE`

Production must not allow arbitrary generic events to impersonate trusted payment or CRM truth.

Maintain:

```text
ESTIMATED != CONFIRMED_SALE != CONFIRMED_PAYMENT
```

## Required Additional Integrity Work

Also preserve / close:

* **Time-of-action** contact-policy recheck (not only plan-time)
* **DNC after approval** still prevents send
* **Inbound response after approval** prevents incompatible follow-up
* **Target containment** immediately before actuation (phone/email must match canonical lead)
* **Phase7 action idempotency** prevents duplicate RecoveryAttempts
* **Tenant/project authorization** must derive from **canonical persisted record scope**, not request-body scope alone
* Scheduler deferral may remain incomplete; **`CONTACT_WINDOW_CLOSED` → zero send** is acceptable for current MVP

## Current Next Test Gate

After the integrity closure passes:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. Control Tower: `npm run control-tower:typecheck` / `control-tower:test` / `control-tower:build`

Then run **product PostgreSQL qualification only after** code-level closure is clean.

Do **not** reset/truncate/drop the accumulated database.

## Prohibited Actions

* no Phase 25
* no commit
* no push
* no deployment
* no real messaging provider
* no real CRM integration
* no real external messages
* no DB reset / truncate / drop
* no bypass of Phase6 / Phase7
* no caller-asserted economic truth
* no inventing authority from Control Tower UI

## Immediate Resume Instruction

The new Cursor conversation should:

1. **Read this handoff first**
2. Inspect the current working tree on `product/revenue-recovery-engine`
3. Continue **only** the Revenue Recovery **authority provenance** + **economic provenance** closure
4. Re-run typecheck / unit / build / Control Tower gates
5. **Only then** consider product PostgreSQL qualification — without DB wipe

Do not expand into Twilio, SendGrid, GoHighLevel, OIDC, or Phase 25.

## Key Code Pointers for Resume

```text
Authorization risk:
  src/api/revenue-recovery.ts          → authorized-action route
  src/revenue-recovery/service.ts      → executeAuthorizedRecoveryAction

Economic risk:
  src/api/revenue-recovery.ts          → leads/:leadId/events
  src/revenue-recovery/service.ts      → appendLeadEvent / attributeFromEvent
  src/revenue-recovery/revenue-attribution.ts

Canonical authority (do not bypass):
  Phase6 authorization services under src/authorization/
  Phase7 execution readiness / SafeActuator under src/execution/

Product Postgres catalog (not yet qualification-run):
  src/infrastructure/postgres/postgres.revenue-recovery.helpers.ts
  src/infrastructure/postgres/postgres.revenue-recovery.test.ts
```
