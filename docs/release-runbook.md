# Release runbook

## Versioning

Application version is `package.json` version plus optional `GIT_COMMIT_SHA` / `BUILD_TIMESTAMP`.
Schema version is migration `003_phase11_final` (Phase 11). Application and schema versions are independent.

Rolling upgrades: do not apply destructive migrations while old nodes still write. Phase 12 adds no destructive production migration.

## Build

```bash
npm run typecheck
npm test
npm run build
npm run test:postgres
```

Container: `docker build -t orchestrator-agent .` (non-root user, no secrets in image).

## Rollback

1. Drain nodes (`SIGTERM`).
2. Deploy previous application image/commit.
3. Do not automatically reverse PostgreSQL migrations unless a dedicated reverse migration exists (none in Phase 12).
4. Confirm `/health/ready` and a read of a known Run id.

## Compatibility

Old application nodes must not assume they can rewrite new schema. Startup `assertCompatible` fails closed on checksum drift or missing required migrations.
