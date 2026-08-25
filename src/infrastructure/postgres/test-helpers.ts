import { randomUUID } from "node:crypto";
import { exampleAdmissionRequest } from "../../admission/fixtures.js";
import type { AdmissionRequest } from "../../admission/request.js";
import { PostgresDatabase } from "./database.js";
import { PostgresMigrationRunner } from "./migrate.js";
import { createPostgresOrchestratorStack } from "./stack.js";

const DEFAULT_TEST_URL =
  process.env["TEST_DATABASE_URL"] ??
  "postgres://orchestrator:orchestrator@127.0.0.1:5432/orchestrator";

export function requireTestDatabaseUrl(): string {
  const url = process.env["TEST_DATABASE_URL"] ?? DEFAULT_TEST_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is required for PostgreSQL integration tests",
    );
  }
  return url;
}

export async function createTestDatabase(
  instanceId: string,
): Promise<PostgresDatabase> {
  const db = new PostgresDatabase({
    connectionString: requireTestDatabaseUrl(),
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    instanceId,
  });
  const runner = new PostgresMigrationRunner(db);
  await runner.migrate();
  await runner.assertCompatible();
  return db;
}

export async function createTestStack(
  instanceId: string,
  opts?: {
    completionFailpoint?: Parameters<typeof createPostgresOrchestratorStack>[0]["completionFailpoint"];
    programCompletionFailpoint?: Parameters<typeof createPostgresOrchestratorStack>[0]["programCompletionFailpoint"];
    programMaterializationFailpoint?: Parameters<typeof createPostgresOrchestratorStack>[0]["programMaterializationFailpoint"];
    promotionFailpoint?: Parameters<typeof createPostgresOrchestratorStack>[0]["promotionFailpoint"];
    schedulerGlobalMaxConcurrency?: number;
  },
) {
  process.env["APPROVAL_DELIVERY_SECRET_KEY"] =
    process.env["APPROVAL_DELIVERY_SECRET_KEY"] ??
    Buffer.alloc(32, 11).toString("base64");
  const db = await createTestDatabase(instanceId);
  const stack = await createPostgresOrchestratorStack({
    db,
    instanceId,
    seedControlPlane: true,
    ...(opts?.completionFailpoint !== undefined
      ? { completionFailpoint: opts.completionFailpoint }
      : {}),
    ...(opts?.programCompletionFailpoint !== undefined
      ? { programCompletionFailpoint: opts.programCompletionFailpoint }
      : {}),
    ...(opts?.programMaterializationFailpoint !== undefined
      ? {
          programMaterializationFailpoint: opts.programMaterializationFailpoint,
        }
      : {}),
    ...(opts?.promotionFailpoint !== undefined
      ? { promotionFailpoint: opts.promotionFailpoint }
      : {}),
    ...(opts?.schedulerGlobalMaxConcurrency !== undefined
      ? {
          schedulerGlobalMaxConcurrency: opts.schedulerGlobalMaxConcurrency,
        }
      : {}),
  });
  return {
    db,
    stack,
    async close() {
      await stack.close();
    },
  };
}

export async function createIndependentDatabase(instanceId: string) {
  const db = new PostgresDatabase({
    connectionString: requireTestDatabaseUrl(),
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    instanceId,
  });
  return db;
}

/**
 * Unique logical admission identity for PostgreSQL tests.
 * Repeat invocations must not collide with durable rows from prior runs.
 * Reuse the returned request object when two calls must be the same identity.
 */
export function buildPostgresTestAdmissionRequest(input: {
  testName: string;
  uniqueSuffix?: string;
  projectId?: string;
  learnable?: boolean;
}): AdmissionRequest {
  const suffix = input.uniqueSuffix ?? randomUUID();
  const token = `${input.testName}-${suffix}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  return exampleAdmissionRequest({
    objectiveId: `pg-${token}`,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.learnable
      ? {
          acceptanceCriteria: [
            "Local patch artifact prepared",
            "Registered test profile executed",
          ],
          constraints: ["Stay within authorized targets"],
          nonGoals: ["GitHub pull request creation"],
          requestedOutcome: "Prepare a local patch and run registered tests",
        }
      : {}),
  });
}

export function uniquePostgresTestId(testName: string): string {
  return `${testName}-${randomUUID()}`;
}

/** Poll PostgreSQL NOW() until the lease row is expired, or fail. */
export async function waitUntilPostgresLeaseExpired(
  db: PostgresDatabase,
  coordinationKey: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await db.query<{ expired: string | number | boolean }>(
      `SELECT CASE WHEN lease_expires_at < NOW() THEN 1 ELSE 0 END AS expired
       FROM coordinator_leases
       WHERE coordination_key = $1`,
      [coordinationKey],
    );
    if (Number(result.rows[0]?.expired) === 1) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(
    `Lease ${coordinationKey} did not expire within ${timeoutMs}ms according to PostgreSQL NOW()`,
  );
}

export async function waitUntilPostgresOutboxLeaseExpired(
  db: PostgresDatabase,
  outboxId: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await db.query<{ expired: string | number | boolean }>(
      `SELECT CASE
         WHEN lease_expires_at IS NULL OR lease_expires_at < NOW() THEN 1
         ELSE 0
       END AS expired
       FROM transactional_outbox
       WHERE outbox_id = $1`,
      [outboxId],
    );
    if (Number(result.rows[0]?.expired) === 1) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(
    `Outbox ${outboxId} lease did not expire within ${timeoutMs}ms according to PostgreSQL NOW()`,
  );
}

export async function createTestStackOnUrl(
  instanceId: string,
  connectionString: string,
  options: { migrate?: boolean } = {},
) {
  process.env["APPROVAL_DELIVERY_SECRET_KEY"] =
    process.env["APPROVAL_DELIVERY_SECRET_KEY"] ??
    Buffer.alloc(32, 11).toString("base64");
  const db = new PostgresDatabase({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    instanceId,
  });
  if (options.migrate !== false) {
    const runner = new PostgresMigrationRunner(db);
    await runner.migrate();
    await runner.assertCompatible();
  } else {
    const runner = new PostgresMigrationRunner(db);
    await runner.assertCompatible();
  }
  const stack = await createPostgresOrchestratorStack({
    db,
    instanceId,
    seedControlPlane: true,
  });
  return {
    db,
    stack,
    async close() {
      await stack.close();
    },
  };
}
