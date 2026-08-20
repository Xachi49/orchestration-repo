# Backup and restore

Backups are **operator** actions. The orchestrator process does not self-backup.

## Expectations

PostgreSQL is the system of record. Application heap is disposable.

```text
RESTORED DATABASE + EMPTY APPLICATION HEAP → SYSTEM AUTHORITY RECOVERABLE
```

## Backup

```bash
export DATABASE_URL=postgres://orchestrator:orchestrator@127.0.0.1:5432/orchestrator
./scripts/backup-postgres.sh ./backups/orchestrator.dump
```

Uses `pg_dump --format=custom`. Does not include credentials in the dump file name contract; do not embed secrets in repository paths committed to git.

## Restore to an isolated database

```bash
createdb orchestrator_restore
./scripts/restore-postgres.sh ./backups/orchestrator.dump postgres://orchestrator:orchestrator@127.0.0.1:5432/orchestrator_restore
```

Then start a **new** runtime against the restored URL. Verify:

- Run
- AuthorizationRecord
- ExecutionAttempt
- CompletionRecord
- artifact blob / hash
- PromotedPrecedent
- observability snapshot

Do not restore onto a live production writer without a documented maintenance window.

## Verification

`npm run test:postgres` includes empty-heap reload, multi-node fencing, and a
disposable-database backup/restore drill (`src/infrastructure/postgres/backup-drill.ts`).
Operator restore drills must use a disposable database, never production `dropdb`.
