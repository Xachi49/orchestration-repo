import type { StorageMode } from "../domain/durability/index.js";
import type { LocalObservabilityStack } from "./observability/local-stack.js";
import { createLocalObservabilityStack } from "./observability/index.js";
import { loadStorageConfig } from "./postgres/config.js";
import { PostgresDatabase } from "./postgres/database.js";
import { PostgresHealthService } from "./postgres/health.js";
import { PostgresMigrationRunner } from "./postgres/migrate.js";
import {
  createPostgresOrchestratorStack,
  type PostgresOrchestratorStack,
} from "./postgres/stack.js";
import { DurabilityError } from "../durability/errors.js";

export type OrchestratorStack = PostgresOrchestratorStack | LocalObservabilityStack;

export interface BootstrapResult {
  storageMode: StorageMode;
  stack: OrchestratorStack;
  health?: Awaited<ReturnType<PostgresHealthService["readiness"]>>;
  close: () => Promise<void>;
}

export async function bootstrapOrchestratorStack(): Promise<BootstrapResult> {
  const config = loadStorageConfig();
  if (config.storageMode === "memory") {
    const stack = createLocalObservabilityStack();
    return {
      storageMode: "memory",
      stack,
      close: async () => undefined,
    };
  }

  const db = new PostgresDatabase({
    connectionString: config.databaseUrl!,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    instanceId: config.instanceId,
  });

  try {
    const runner = new PostgresMigrationRunner(db);
    await runner.migrate();
    await runner.assertCompatible();
    const health = await new PostgresHealthService(db, "postgres").readiness();
    if (!health.databaseReachable || !health.schemaCompatible) {
      throw new DurabilityError(
        "DATABASE_UNAVAILABLE",
        "PostgreSQL readiness check failed",
        health as unknown as Record<string, unknown>,
      );
    }
    const stack = await createPostgresOrchestratorStack({
      db,
      instanceId: config.instanceId,
    });
    const recoveryItems = await stack.recovery.recover();
    void recoveryItems;
    return {
      storageMode: "postgres",
      stack,
      health,
      close: async () => {
        await stack.close();
      },
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}
