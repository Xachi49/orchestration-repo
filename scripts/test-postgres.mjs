#!/usr/bin/env node
import { execSync } from "node:child_process";
import pg from "pg";

const url =
  process.env["TEST_DATABASE_URL"] ??
  "postgres://orchestrator:orchestrator@127.0.0.1:5432/orchestrator";

async function assertDatabaseReachable() {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown connection error";
    console.error(
      `PostgreSQL integration tests require a reachable TEST_DATABASE_URL.\n` +
        `Set TEST_DATABASE_URL or start docker compose -f docker-compose.postgres.yml up -d\n` +
        `Attempted: ${url.replace(/:[^:@/]+@/, ":***@")}\n` +
        `Error: ${message}`,
    );
    process.exit(1);
  } finally {
    await client.end().catch(() => undefined);
  }
}

await assertDatabaseReachable();

process.env["TEST_DATABASE_URL"] = url;
process.env["APPROVAL_DELIVERY_SECRET_KEY"] =
  process.env["APPROVAL_DELIVERY_SECRET_KEY"] ??
  Buffer.alloc(32, 11).toString("base64");

try {
  execSync(
    "npx vitest run --fileParallelism=false src/infrastructure/postgres/postgres.durability.test.ts src/infrastructure/postgres/postgres.integration.test.ts src/infrastructure/postgres/postgres.resource-ledger.test.ts src/infrastructure/postgres/postgres.acceptance.test.ts src/infrastructure/postgres/postgres.phase12.test.ts src/infrastructure/postgres/postgres.phase13.test.ts src/infrastructure/postgres/postgres.phase14.test.ts src/infrastructure/postgres/postgres.phase15.test.ts src/infrastructure/postgres/postgres.phase16.test.ts src/infrastructure/postgres/postgres.phase17.test.ts src/infrastructure/postgres/postgres.phase18.test.ts",
    {
      stdio: "inherit",
      env: process.env,
    },
  );
} catch {
  process.exit(1);
}
