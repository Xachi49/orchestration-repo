# Control Tower MVP

Operator-facing interface for the governed orchestration platform (Phases 0–24).

**CONTROL TOWER ≠ AUTHORITY**

The Control Tower creates no authority of its own. Every action is:

```text
BUTTON CLICK
→ REQUEST TO CANONICAL API
→ SERVER AUTHORIZATION
→ DOMAIN ACTION
```

Server responses remain authoritative. The UI never invents lifecycle success.

## Purpose

Make the ordinary lifecycle usable without curl/SQL:

OBJECTIVE → REPOSITORY TRUTH → PLANNING → VALIDATION → HUMAN AUTHORIZATION → EXECUTION → VERIFICATION → COMPLETION

Plus read-only visibility for Assurance and Release Qualification.

## Local development

Terminal 1 — API (memory or postgres per runtime config):

```bash
npm start
```

Recommended for Control Tower local harness:

```bash
ORCHESTRATOR_AUTH_MODE=HEADER_PRINCIPAL \
ORCHESTRATOR_ACCESS_BINDINGS='user_local:discord-scale-architect;approver_bootstrap:discord-scale-architect' \
npm start
```

Optional explicit unrestricted read fixture (DEVELOPMENT/TEST only; default false):

```bash
ORCHESTRATOR_CONTROL_TOWER_DEV_ALLOW_ALL=true
```

**ANONYMOUS ≠ AUTHENTICATED PRINCIPAL.** Empty bindings never grant all projects.
Without bindings or the explicit allow-all flag, Control Tower collections are empty
and unauthorized run detail returns 403.

Terminal 2 — Control Tower:

```bash
npm run control-tower:dev
```

Open http://127.0.0.1:5173

Vite proxies `/v1` and `/health` to `http://127.0.0.1:3000`.

### Development principal selector

sessionStorage may store a **development principal selector** used only to set
`x-orchestrator-principal` under `HEADER_PRINCIPAL` mode.

**This is not an authentication credential.**

Do not store approval nonces, bearer secrets, database credentials, API keys,
or governance proofs in sessionStorage / localStorage.

Default selector: `user_local`. Approvals in local stacks typically require
acting as `approver_bootstrap` (explicit selector — not invisible production
behavior).

When `HEADER_PRINCIPAL` is enabled, the UI shows **DEVELOPMENT IDENTITY MODE**.

## Authentication / authorization boundary

| Layer | Meaning |
| --- | --- |
| Authenticated principal | Server-verifiable identity (PRODUCTION must not trust client headers) |
| `x-orchestrator-principal` | **DEVELOPMENT AUTH ONLY** adapter — client-chosen string |
| Project access bindings | Whether the principal may *see* a project |
| Approver grants | Whether they may decide approvals |
| Domain services | Whether the action is legal |

```text
CLIENT-PROVIDED PRINCIPAL
≠
AUTHENTICATED PRINCIPAL
```

PRODUCTION rejects `ORCHESTRATOR_AUTH_MODE=HEADER_PRINCIPAL` (fail closed).
Do not invent fake production authentication. Until a real provider exists,
PRODUCTION may use server-bound `STATIC_PRINCIPAL` only — never header trust,
and never bootstrap principal fallback.

The browser must never send `isAdmin` / role claims as authority.

## API dependencies

Existing canonical routes (unchanged semantics):

- `POST /v1/runs`
- `POST /v1/runs/:runId/ingest|plan|validate|authorization-route|execute|verify`
- `POST /v1/approval-requests/:id/decision`
- nested GETs for plan/validation/execution/verification
- `/health/live`, `/health/ready`

Control Tower read models (composition only):

- `GET /v1/control-tower/dashboard`
- `GET /v1/control-tower/identity-mode`
- `GET /v1/control-tower/projects`
- `GET /v1/runs`
- `GET /v1/runs/:runId`
- `GET /v1/runs/:runId/timeline`
- `GET /v1/runs/:runId/evidence`
- `GET /v1/approvals` (scoped to principal project access — visibility ≠ authority)
- `GET /v1/approvals/:id`
- `GET /v1/approvals/:id/local-delivery` (**DEVELOPMENT/TEST fake delivery only**; not registered in PRODUCTION)
- `GET /v1/system/assurance`
- `GET /v1/system/qualification`

`decisionNonceHash` and nested secret-like metadata are never returned on public
approval / evidence projections.

## Screens

| Screen | Path |
| --- | --- |
| Dashboard | `/` |
| Objective submit | `/objectives` |
| Runs | `/runs` |
| Run detail + timeline | `/runs/:runId` |
| Approval inbox | `/approvals` |
| Approval decision | `/approvals/:id` |
| Evidence | `/evidence` |
| Assurance | `/assurance` |
| Qualification | `/qualification` |
| Governance / Federation | read-only placeholders |

## Doctrine displayed in UI

- PASS ≠ APPROVED
- EXECUTION_SUCCEEDED ≠ VERIFIED_SUCCESS
- VERIFIED_SUCCESS ≠ COMPLETED
- CERTIFICATE ≠ OPERATIONAL AUTHORITY
- QUALIFIED_FOR_RELEASE ≠ DEPLOYED
- LIVE ≠ READY
- CLIENT-PROVIDED PRINCIPAL ≠ AUTHENTICATED PRINCIPAL

## Security

- No PostgreSQL access from the browser
- No secrets in localStorage / build-time public env
- Principal selector in sessionStorage for DEVELOPMENT header forwarding only
- Approval nonce held only in component memory; discarded after decide
- No Deploy, force-approve, skip-validation, or shell controls
- Read models filtered server-side by project access

## Build / test

```bash
npm run typecheck
npm test
npm run build
npm run control-tower:typecheck
npm run control-tower:test
npm run control-tower:build
```
