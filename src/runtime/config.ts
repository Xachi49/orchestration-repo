import { z } from "zod";
import { STORAGE_MODES, type StorageMode } from "../domain/durability/index.js";
import { RuntimeError } from "./errors.js";
import { loadBuildIdentity, newRuntimeId, type BuildIdentity } from "./identity.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

export const RUNTIME_ENVIRONMENTS = [
  "TEST",
  "DEVELOPMENT",
  "STAGING",
  "PRODUCTION",
] as const;
export type RuntimeEnvironment = (typeof RUNTIME_ENVIRONMENTS)[number];

export const RUNTIME_ROLES = ["API", "WORKER", "COMBINED"] as const;
export type RuntimeRole = (typeof RUNTIME_ROLES)[number];

export const AUTHENTICATION_MODES = [
  "ANONYMOUS",
  "HEADER_PRINCIPAL",
  "STATIC_PRINCIPAL",
] as const;
export type AuthenticationMode = (typeof AUTHENTICATION_MODES)[number];

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const positiveInt = z.number().int().positive();

export const RuntimeConfigSchema = z
  .object({
    runtimeEnvironment: z.enum(RUNTIME_ENVIRONMENTS),
    storageMode: z.enum(STORAGE_MODES),
    databaseUrl: z.string().min(1).optional(),
    poolMax: z.number().int().min(1).max(100),
    connectionTimeoutMs: positiveInt,
    idleTimeoutMs: positiveInt,
    shutdownGraceMs: positiveInt,
    workerConcurrency: z.number().int().min(1).max(64),
    pollIntervalMs: positiveInt,
    pollJitterMs: z.number().int().min(0).max(10_000),
    leaseHeartbeatMs: positiveInt,
    httpHost: z.string().min(1),
    httpPort: z.number().int().min(1).max(65535),
    bodyLimitBytes: z.number().int().min(1024).max(5_000_000),
    requestTimeoutMs: positiveInt,
    authenticationMode: z.enum(AUTHENTICATION_MODES),
    staticPrincipalId: z.string().min(1).optional(),
    accessBindings: z.array(
      z.object({
        principalId: z.string().min(1),
        projectIds: z.array(z.string().min(1)).min(1),
      }),
    ),
    deliverySecretConfigured: z.boolean(),
    debugMode: z.boolean(),
    runtimeRole: z.enum(RUNTIME_ROLES),
    runtimeId: z.string().min(1),
    logLevel: z.enum(LOG_LEVELS),
    mutationRateLimit: z.number().int().min(1).max(10_000),
    mutationRateWindowMs: positiveInt,
    outboxMaxAttempts: z.number().int().min(1).max(100),
    modelProviderEnabled: z.boolean(),
    build: z.object({
      applicationVersion: z.string().min(1),
      nodeVersion: z.string().min(1),
      runtimeEnvironment: z.string().min(1),
      gitCommitSha: z.string().min(1).optional(),
      buildTimestamp: z.string().min(1).optional(),
    }),
  })
  .strict();

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

function env(map: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = map[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function parseIntEnv(
  map: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env(map, name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new RuntimeError(
      "RUNTIME_CONFIG_INVALID",
      `${name} must be a finite number`,
    );
  }
  return value;
}

function parseAccessBindings(
  raw: string | undefined,
): RuntimeConfig["accessBindings"] {
  if (!raw) {
    return [];
  }
  return raw.split(";").filter(Boolean).map((entry) => {
    const [principalId, projects] = entry.split(":");
    if (!principalId || !projects) {
      throw new RuntimeError(
        "RUNTIME_CONFIG_INVALID",
        "ORCHESTRATOR_ACCESS_BINDINGS entries must be principalId:project[,project]",
      );
    }
    return {
      principalId,
      projectIds: projects.split(",").filter(Boolean),
    };
  });
}

export function loadRuntimeConfig(
  envMap: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const runtimeEnvironment = (env(
    envMap,
    "ORCHESTRATOR_ENV",
  ) ?? "DEVELOPMENT") as string;
  if (
    !(RUNTIME_ENVIRONMENTS as readonly string[]).includes(runtimeEnvironment)
  ) {
    throw new RuntimeError(
      "RUNTIME_CONFIG_INVALID",
      `Unknown runtime environment: ${runtimeEnvironment}`,
    );
  }

  const storageRaw = (env(envMap, "ORCHESTRATOR_STORAGE") ?? "memory").toLowerCase();
  if (!(STORAGE_MODES as readonly string[]).includes(storageRaw)) {
    throw new RuntimeError(
      "RUNTIME_CONFIG_INVALID",
      `ORCHESTRATOR_STORAGE must be memory|postgres, got ${storageRaw}`,
    );
  }
  const storageMode = storageRaw as StorageMode;
  const databaseUrl = env(envMap, "DATABASE_URL");
  const authenticationMode = (env(envMap, "ORCHESTRATOR_AUTH_MODE") ??
    "ANONYMOUS") as string;
  if (!(AUTHENTICATION_MODES as readonly string[]).includes(authenticationMode)) {
    throw new RuntimeError(
      "RUNTIME_CONFIG_INVALID",
      `Unknown authentication mode: ${authenticationMode}`,
    );
  }
  const runtimeRole = (env(envMap, "ORCHESTRATOR_ROLE") ?? "COMBINED") as string;
  if (!(RUNTIME_ROLES as readonly string[]).includes(runtimeRole)) {
    throw new RuntimeError(
      "RUNTIME_CONFIG_INVALID",
      `Unknown runtime role: ${runtimeRole}`,
    );
  }
  const logLevel = (env(envMap, "ORCHESTRATOR_LOG_LEVEL") ?? "info") as string;
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
    throw new RuntimeError(
      "RUNTIME_CONFIG_INVALID",
      `Unknown log level: ${logLevel}`,
    );
  }

  const debugMode =
    env(envMap, "ORCHESTRATOR_DEBUG") === "1" ||
    env(envMap, "ORCHESTRATOR_DEBUG") === "true";
  const deliverySecret = env(envMap, "APPROVAL_DELIVERY_SECRET_KEY");
  const staticPrincipalId = env(envMap, "ORCHESTRATOR_STATIC_PRINCIPAL_ID");
  const workerConcurrency = parseIntEnv(
    envMap,
    "ORCHESTRATOR_WORKER_CONCURRENCY",
    4,
  );
  const poolMax = parseIntEnv(envMap, "ORCHESTRATOR_PG_POOL_MAX", 10);
  const shutdownGraceMs = parseIntEnv(
    envMap,
    "ORCHESTRATOR_SHUTDOWN_GRACE_MS",
    15_000,
  );

  const draft: RuntimeConfig = {
    runtimeEnvironment: runtimeEnvironment as RuntimeEnvironment,
    storageMode,
    poolMax,
    connectionTimeoutMs: parseIntEnv(
      envMap,
      "ORCHESTRATOR_PG_CONNECTION_TIMEOUT_MS",
      5_000,
    ),
    idleTimeoutMs: parseIntEnv(envMap, "ORCHESTRATOR_PG_IDLE_TIMEOUT_MS", 30_000),
    shutdownGraceMs,
    workerConcurrency,
    pollIntervalMs: parseIntEnv(envMap, "ORCHESTRATOR_POLL_INTERVAL_MS", 1_000),
    pollJitterMs: parseIntEnv(envMap, "ORCHESTRATOR_POLL_JITTER_MS", 250),
    leaseHeartbeatMs: parseIntEnv(
      envMap,
      "ORCHESTRATOR_LEASE_HEARTBEAT_MS",
      5_000,
    ),
    httpHost: env(envMap, "ORCHESTRATOR_HTTP_HOST") ?? "127.0.0.1",
    httpPort: parseIntEnv(envMap, "ORCHESTRATOR_HTTP_PORT", 3000),
    bodyLimitBytes: parseIntEnv(envMap, "ORCHESTRATOR_BODY_LIMIT_BYTES", 256_000),
    requestTimeoutMs: parseIntEnv(
      envMap,
      "ORCHESTRATOR_REQUEST_TIMEOUT_MS",
      30_000,
    ),
    authenticationMode: authenticationMode as AuthenticationMode,
    accessBindings: parseAccessBindings(env(envMap, "ORCHESTRATOR_ACCESS_BINDINGS")),
    deliverySecretConfigured: Boolean(deliverySecret),
    debugMode,
    runtimeRole: runtimeRole as RuntimeRole,
    runtimeId: env(envMap, "ORCHESTRATOR_INSTANCE_ID") ?? newRuntimeId(),
    logLevel: logLevel as LogLevel,
    mutationRateLimit: parseIntEnv(
      envMap,
      "ORCHESTRATOR_MUTATION_RATE_LIMIT",
      60,
    ),
    mutationRateWindowMs: parseIntEnv(
      envMap,
      "ORCHESTRATOR_MUTATION_RATE_WINDOW_MS",
      60_000,
    ),
    outboxMaxAttempts: parseIntEnv(envMap, "ORCHESTRATOR_OUTBOX_MAX_ATTEMPTS", 8),
    modelProviderEnabled: env(envMap, "ORCHESTRATOR_MODEL_PROVIDER") === "openai",
    build: loadBuildIdentity({
      runtimeEnvironment,
      applicationVersion: pkg.version,
      env: envMap,
    }) as BuildIdentity & { applicationVersion: string; nodeVersion: string; runtimeEnvironment: string },
  };
  if (databaseUrl !== undefined) {
    draft.databaseUrl = databaseUrl;
  }
  if (staticPrincipalId !== undefined) {
    draft.staticPrincipalId = staticPrincipalId;
  }

  assertProductionInvariants(draft);
  return RuntimeConfigSchema.parse(draft);
}

export function assertProductionInvariants(config: RuntimeConfig): void {
  if (config.runtimeEnvironment !== "PRODUCTION") {
    if (config.storageMode === "postgres" && !config.databaseUrl) {
      throw new RuntimeError(
        "RUNTIME_CONFIG_INVALID",
        "postgres storage requires DATABASE_URL",
      );
    }
    if (
      config.authenticationMode === "STATIC_PRINCIPAL" &&
      !config.staticPrincipalId
    ) {
      throw new RuntimeError(
        "RUNTIME_CONFIG_INVALID",
        "STATIC_PRINCIPAL requires ORCHESTRATOR_STATIC_PRINCIPAL_ID",
      );
    }
    return;
  }

  if (config.storageMode === "memory") {
    throw new RuntimeError(
      "PRODUCTION_MEMORY_STORAGE_FORBIDDEN",
      "PRODUCTION cannot use MEMORY authoritative storage",
    );
  }
  if (!config.databaseUrl) {
    throw new RuntimeError(
      "PRODUCTION_DATABASE_URL_REQUIRED",
      "PRODUCTION requires DATABASE_URL",
    );
  }
  if (config.authenticationMode === "ANONYMOUS") {
    throw new RuntimeError(
      "PRODUCTION_ANONYMOUS_AUTH_FORBIDDEN",
      "PRODUCTION cannot use anonymous authentication",
    );
  }
  if (
    config.authenticationMode === "STATIC_PRINCIPAL" &&
    !config.staticPrincipalId
  ) {
    throw new RuntimeError(
      "RUNTIME_CONFIG_INVALID",
      "STATIC_PRINCIPAL requires ORCHESTRATOR_STATIC_PRINCIPAL_ID",
    );
  }
  if (!config.deliverySecretConfigured) {
    throw new RuntimeError(
      "PRODUCTION_DELIVERY_SECRET_REQUIRED",
      "PRODUCTION requires APPROVAL_DELIVERY_SECRET_KEY",
    );
  }
  if (config.debugMode) {
    throw new RuntimeError(
      "PRODUCTION_DEBUG_FORBIDDEN",
      "PRODUCTION cannot enable debug mode",
    );
  }
  if (!Number.isFinite(config.workerConcurrency) || config.workerConcurrency < 1) {
    throw new RuntimeError(
      "PRODUCTION_UNBOUNDED_CONCURRENCY",
      "PRODUCTION worker concurrency must be a positive bound",
    );
  }
  if (config.modelProviderEnabled && !config.databaseUrl) {
    throw new RuntimeError(
      "RUNTIME_CONFIG_INVALID",
      "Enabled model provider still requires durable postgres configuration",
    );
  }
}
