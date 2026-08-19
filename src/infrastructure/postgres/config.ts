import {
  STORAGE_MODES,
  type StorageMode,
} from "../../domain/durability/index.js";
import { DurabilityError } from "../../durability/errors.js";

export interface OrchestratorStorageConfig {
  storageMode: StorageMode;
  databaseUrl?: string;
  instanceId: string;
  poolMax: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export function parseStorageMode(
  raw: string | undefined = env("ORCHESTRATOR_STORAGE"),
): StorageMode {
  const value = (raw ?? "memory").trim().toLowerCase();
  if ((STORAGE_MODES as readonly string[]).includes(value)) {
    return value as StorageMode;
  }
  throw new DurabilityError(
    "STORAGE_MODE_INVALID",
    `ORCHESTRATOR_STORAGE must be memory|postgres, got ${raw ?? "<unset>"}`,
  );
}

export function loadStorageConfig(
  envMap: NodeJS.ProcessEnv = process.env,
): OrchestratorStorageConfig {
  const storageMode = parseStorageMode(envMap["ORCHESTRATOR_STORAGE"]);
  const databaseUrl = envMap["DATABASE_URL"];
  const instanceId =
    envMap["ORCHESTRATOR_INSTANCE_ID"] ?? `instance_${crypto.randomUUID()}`;
  const poolMax = Number(envMap["ORCHESTRATOR_PG_POOL_MAX"] ?? 10);
  const connectionTimeoutMs = Number(
    envMap["ORCHESTRATOR_PG_CONNECTION_TIMEOUT_MS"] ?? 5_000,
  );
  const idleTimeoutMs = Number(
    envMap["ORCHESTRATOR_PG_IDLE_TIMEOUT_MS"] ?? 30_000,
  );

  if (storageMode === "postgres" && !databaseUrl) {
    throw new DurabilityError(
      "DATABASE_UNAVAILABLE",
      "ORCHESTRATOR_STORAGE=postgres requires DATABASE_URL",
    );
  }

  const config: OrchestratorStorageConfig = {
    storageMode,
    instanceId,
    poolMax: Number.isFinite(poolMax) ? poolMax : 10,
    connectionTimeoutMs: Number.isFinite(connectionTimeoutMs)
      ? connectionTimeoutMs
      : 5_000,
    idleTimeoutMs: Number.isFinite(idleTimeoutMs) ? idleTimeoutMs : 30_000,
  };
  if (databaseUrl !== undefined) {
    config.databaseUrl = databaseUrl;
  }
  return config;
}
