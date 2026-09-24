import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "./config.js";
import type { StartupLifecycle } from "./startup.js";
import type { DrainController } from "./startup.js";
import type { OperationalMetrics } from "./metrics.js";
import type { DatabaseReadiness } from "../infrastructure/postgres/health.js";
import type { BuildIdentity } from "./identity.js";

export interface HealthDeps {
  config: RuntimeConfig;
  startup: StartupLifecycle;
  drain: DrainController;
  metrics: OperationalMetrics;
  build: BuildIdentity;
  database?: () => Promise<DatabaseReadiness>;
  poolStats?: () => { total: number; idle: number; waiting: number };
  worker?: { active: number; claims: number; skippedBackpressure: number };
  recoverySummary?: () => Promise<{ items: number }>;
  outboxSummary?: () => Promise<{ pending: number }>;
  /** Non-secret repository adapter kinds (PRODUCTION must be GITHUB + LOCAL_GIT). */
  repositoryRemoteAdapter?: "GITHUB" | "FAKE";
  repositoryWorkspaceAdapter?: "LOCAL_GIT" | "FAKE";
  /** Non-secret GitHub HTTP auth mode; null when FAKE adapters are selected. */
  githubAuthenticationMode?: "TOKEN" | "PUBLIC_ANONYMOUS" | null;
  /** Non-secret planning model provider actually wired (not toolsEnabled). */
  planningModelProvider?: "OPENAI" | "FAKE" | null;
  planningModelConfigured?: boolean | null;
  planningModelId?: string | null;
}

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: HealthDeps,
): void {
  app.get("/health/live", async () => ({
    status: "ok",
    alive: true,
    runtimeId: deps.config.runtimeId,
  }));

  app.get("/health/ready", async (_request, reply) => {
    const db = deps.database ? await deps.database() : undefined;
    const databaseOk =
      deps.database === undefined ||
      (db?.databaseReachable === true && db.schemaCompatible === true);
    const ready =
      deps.startup.isReady() &&
      deps.drain.isAcceptingWork() &&
      databaseOk;
    const body = {
      ready,
      startup: deps.startup.current(),
      draining: !deps.drain.isAcceptingWork(),
      storageMode: deps.config.storageMode,
      databaseReachable: db?.databaseReachable ?? null,
      schemaCompatible: db?.schemaCompatible ?? null,
    };
    return reply.status(ready ? 200 : 503).send(body);
  });

  app.get("/health/info", async () => ({
    version: deps.build.applicationVersion,
    gitCommitSha: deps.build.gitCommitSha ?? null,
    buildTimestamp: deps.build.buildTimestamp ?? null,
    runtimeEnvironment: deps.build.runtimeEnvironment,
    nodeVersion: deps.build.nodeVersion,
    runtimeId: deps.config.runtimeId,
    role: deps.config.runtimeRole,
    repositoryRemoteAdapter: deps.repositoryRemoteAdapter ?? null,
    repositoryWorkspaceAdapter: deps.repositoryWorkspaceAdapter ?? null,
    githubAuthenticationMode: deps.githubAuthenticationMode ?? null,
    planningModelProvider: deps.planningModelProvider ?? null,
    planningModelConfigured: deps.planningModelConfigured ?? null,
    planningModelId: deps.planningModelId ?? null,
  }));

  app.get("/ops/diagnostics", async () => ({
    startup: deps.startup.current(),
    startupTrail: deps.startup.trail(),
    drain: deps.drain.current(),
    metrics: deps.metrics.snapshot(),
    pool: deps.poolStats?.() ?? null,
    worker: deps.worker ?? null,
    recovery: deps.recoverySummary ? await deps.recoverySummary() : null,
    outbox: deps.outboxSummary ? await deps.outboxSummary() : null,
  }));
}
