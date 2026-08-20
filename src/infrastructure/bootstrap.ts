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

export type BootstrapPhase =
  | "DATABASE_CONNECTED"
  | "SCHEMA_VERIFIED"
  | "RECOVERY_RUNNING"
  | "RECOVERY_COMPLETE";

export interface BootstrapOptions {
  storageMode?: StorageMode;
  databaseUrl?: string;
  instanceId?: string;
  poolMax?: number;
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
  onPhase?: (phase: BootstrapPhase) => void;
}

export interface BootstrapResult {
  storageMode: StorageMode;
  stack: OrchestratorStack;
  health?: Awaited<ReturnType<PostgresHealthService["readiness"]>>;
  close: () => Promise<void>;
}

export async function bootstrapOrchestratorStack(
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const fileConfig = loadStorageConfig();
  const storageMode = options.storageMode ?? fileConfig.storageMode;
  if (storageMode === "memory") {
    const stack = createLocalObservabilityStack();
    return {
      storageMode: "memory",
      stack,
      close: async () => undefined,
    };
  }

  const databaseUrl = options.databaseUrl ?? fileConfig.databaseUrl;
  if (!databaseUrl) {
    throw new DurabilityError(
      "DATABASE_UNAVAILABLE",
      "ORCHESTRATOR_STORAGE=postgres requires DATABASE_URL",
    );
  }

  const db = new PostgresDatabase({
    connectionString: databaseUrl,
    max: options.poolMax ?? fileConfig.poolMax,
    connectionTimeoutMillis:
      options.connectionTimeoutMs ?? fileConfig.connectionTimeoutMs,
    idleTimeoutMillis: options.idleTimeoutMs ?? fileConfig.idleTimeoutMs,
    instanceId: options.instanceId ?? fileConfig.instanceId,
  });

  try {
    const reachable = await db.ping();
    if (!reachable) {
      throw new DurabilityError(
        "DATABASE_UNAVAILABLE",
        "PostgreSQL ping failed",
      );
    }
    options.onPhase?.("DATABASE_CONNECTED");
    const runner = new PostgresMigrationRunner(db);
    await runner.migrate();
    await runner.assertCompatible();
    options.onPhase?.("SCHEMA_VERIFIED");
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
      instanceId: options.instanceId ?? fileConfig.instanceId,
    });
    options.onPhase?.("RECOVERY_RUNNING");
    const recoveryItems = await stack.recovery.recover();
    void recoveryItems;
    options.onPhase?.("RECOVERY_COMPLETE");
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
