# Release runbook

## Versioning

Application version is `package.json` version plus optional `GIT_COMMIT_SHA` / `BUILD_TIMESTAMP`.
Schema version is migration `011_phase16_scenario_intelligence` (Phase 16). Application and schema versions are independent.

Migration `011_phase16_scenario_intelligence` adds strategic decision problems,
scenario sets, simulation results, decision packages, strategy selection,
portfolio lineage, calibration records, usage ledgers, scheduler scenario work
kinds, and `STRATEGY_SELECTOR`. See
[phase-16-scenario-intelligence.md](phase-16-scenario-intelligence.md).

Migration `010_phase15_portfolios` adds Portfolio aggregates, budget ledger,
authorization, lineage, completion, scheduler portfolio work kinds, and
`PORTFOLIO_ALLOCATOR`. See [phase-15-strategic-portfolio.md](phase-15-strategic-portfolio.md).

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
