# Revenue Recovery — Operations

## Configuration

Tenant/project `RecoveryConfiguration` is versioned. Historical cases bind the
config version/fingerprint used at open time.

Key fields:

- `responseGapThresholdMinutes`
- `allowedChannels`
- `contactWindow` + IANA `timezone` (fail closed if invalid)
- attempt ceilings (cannot exceed code safety ceilings)
- `attributionWindowDays`

Env for local Control Tower demos typically uses project
`discord-scale-architect` and customer `continuum_demo_tenant`.

## Safety floor

- DO_NOT_CONTACT / consent revoked → no outreach
- recipient must match canonical lead channel
- max attempts bounded in code + config
- no contact outside configured windows
- no real external messaging in MVP

## Webhook security

Production must not accept unauthenticated public lead ingestion. Reuse
orchestrator perimeter authentication. MVP webhook is for authenticated
internal / DEVELOPMENT-TEST use.

## Logging

Do not log raw phone, email, or full message bodies in ordinary structured
logs. Prefer IDs and masked values.

## Schema

`SUPPORTED_SCHEMA_VERSION` includes `021_product_revenue_recovery_integrity`.
