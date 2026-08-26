import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "./config.js";
import { loadRuntimeConfig } from "./config.js";
import { StartupLifecycle, DrainController } from "./startup.js";
import { MemoryStructuredLogger } from "./logging.js";
import { OperationalMetrics } from "./metrics.js";
import { InMemoryProjectAccessDirectory } from "./access.js";
import { createRequestAuthenticator } from "./auth.js";
import { SlidingWindowRateLimiter } from "./rate-limit.js";
import { BoundedWorkerLoop } from "./worker.js";
import { RuntimeError, isRuntimeError } from "./errors.js";
import { redactUnknown } from "./logging.js";
import { bootstrapOrchestratorStack } from "../infrastructure/bootstrap.js";
import type { BootstrapResult } from "../infrastructure/bootstrap.js";
import { buildServer } from "../api/server.js";
import { PostgresHealthService } from "../infrastructure/postgres/health.js";
import type { PostgresOrchestratorStack } from "../infrastructure/postgres/stack.js";
import {
  SchedulerClaimLoop,
  SchedulerDiscoveryLoop,
  SchedulerDispatcher,
} from "../scheduling/index.js";

export interface OrchestratorRuntime {
  config: RuntimeConfig;
  startup: StartupLifecycle;
  drain: DrainController;
  metrics: OperationalMetrics;
  logger: MemoryStructuredLogger;
  app?: FastifyInstance;
  boot?: BootstrapResult;
  worker?: BoundedWorkerLoop;
  start: () => Promise<void>;
  close: () => Promise<void>;
}

export function createOrchestratorRuntime(
  envMap: NodeJS.ProcessEnv = process.env,
): OrchestratorRuntime {
  const startup = new StartupLifecycle();
  let config: RuntimeConfig;
  try {
    config = loadRuntimeConfig(envMap);
    startup.advance("CONFIG_VALIDATED");
  } catch (error) {
    startup.fail(redactUnknown(error));
    throw error;
  }

  const logger = new MemoryStructuredLogger(config.runtimeId);
  const metrics = new OperationalMetrics();
  const drain = new DrainController();
  const access = new InMemoryProjectAccessDirectory(config.accessBindings);
  const authenticator = createRequestAuthenticator({
    mode: config.authenticationMode,
    ...(config.staticPrincipalId !== undefined
      ? { staticPrincipalId: config.staticPrincipalId }
      : {}),
  });
  const rateLimiter = new SlidingWindowRateLimiter(
    config.mutationRateLimit,
    config.mutationRateWindowMs,
  );

  logger.log({
    level: "info",
    operation: "runtime.config",
    result: "validated",
    message: "runtime configuration validated",
    runtimeEnvironment: config.runtimeEnvironment,
    gitCommitSha: config.build.gitCommitSha,
    applicationVersion: config.build.applicationVersion,
  });

  let boot: BootstrapResult | undefined;
  let app: FastifyInstance | undefined;
  let worker: BoundedWorkerLoop | undefined;
  const startedAt = Date.now();

  const runtime: OrchestratorRuntime = {
    config,
    startup,
    drain,
    metrics,
    logger,
    async start(opts: { listen?: boolean } = {}) {
      if (startup.current() === "STARTUP_FAILED") {
        throw new RuntimeError("STARTUP_FAILED", startup.failureReason() ?? "startup failed");
      }
      try {
        boot = await bootstrapOrchestratorStack({
          storageMode: config.storageMode,
          instanceId: config.runtimeId,
          poolMax: config.poolMax,
          connectionTimeoutMs: config.connectionTimeoutMs,
          idleTimeoutMs: config.idleTimeoutMs,
          ...(config.databaseUrl !== undefined
            ? { databaseUrl: config.databaseUrl }
            : {}),
          onPhase: (phase) => {
            if (phase === "DATABASE_CONNECTED") startup.advance("DATABASE_CONNECTED");
            if (phase === "SCHEMA_VERIFIED") startup.advance("SCHEMA_VERIFIED");
            if (phase === "RECOVERY_RUNNING") startup.advance("RECOVERY_RUNNING");
            if (phase === "RECOVERY_COMPLETE") startup.advance("RECOVERY_COMPLETE");
          },
        });
        runtime.boot = boot;
        if (config.storageMode === "memory") {
          startup.advance("SERVICES_READY");
        } else {
          startup.advance("SERVICES_READY");
        }

        const postgres =
          boot.storageMode === "postgres"
            ? (boot.stack as PostgresOrchestratorStack)
            : undefined;

        if (config.runtimeRole !== "WORKER") {
          app = await buildServer({
            admission: boot.stack.admission,
            ingestion: boot.stack.ingestion,
            planning: boot.stack.planning,
            validation: boot.stack.validation,
            authorizationRouting: boot.stack.authorizationRouting,
            humanAuthorization: boot.stack.humanAuthorization,
            approvalExpiry: boot.stack.approvalExpiry,
            authorizationReadiness: boot.stack.authorizationReadiness,
            execution: boot.stack.execution,
            executionReadiness: boot.stack.executionReadiness,
            verification: boot.stack.verification,
            verificationReadiness: boot.stack.verificationReadiness,
            memory: boot.stack.memory,
            observability: boot.stack.observability,
            ...(postgres
              ? {
                  scheduler: postgres.scheduler,
                  runs: postgres.runs,
                  programService: postgres.programService,
                  programs: postgres.programs,
                  programPlans: postgres.programPlans,
                  portfolioService: postgres.portfolioService,
                  portfolios: postgres.portfolios,
                  portfolioPlans: postgres.portfolioPlans,
                }
              : {}),
            storageMode: boot.storageMode,
            ...(boot.health ? { readiness: boot.health } : {}),
            perimeter: {
              authenticator,
              access,
              drain,
              metrics,
              logger,
              rateLimiter,
              authenticationMode: config.authenticationMode,
              ...(postgres
                ? {
                    runs: postgres.runs,
                    approvalRequests: postgres.approvalRequests,
                    workItems: postgres.schedulerWorkItems,
                    databaseAvailable: () => postgres.db.ping(),
                  }
                : {}),
            },
            health: {
              config,
              startup,
              drain,
              metrics,
              build: {
                applicationVersion: config.build.applicationVersion,
                nodeVersion: config.build.nodeVersion,
                runtimeEnvironment: config.build.runtimeEnvironment,
                ...(config.build.gitCommitSha !== undefined
                  ? { gitCommitSha: config.build.gitCommitSha }
                  : {}),
                ...(config.build.buildTimestamp !== undefined
                  ? { buildTimestamp: config.build.buildTimestamp }
                  : {}),
              },
              ...(postgres
                ? {
                    database: () =>
                      new PostgresHealthService(postgres.db, "postgres").readiness(),
                    poolStats: () => postgres.db.poolStats(),
                    recoverySummary: async () => ({
                      items: (await postgres.leases.listExpired()).length,
                    }),
                    outboxSummary: async () => ({
                      pending: await postgres.outbox.countPending(),
                    }),
                  }
                : {}),
            },
            bodyLimitBytes: config.bodyLimitBytes,
            requestTimeoutMs: config.requestTimeoutMs,
          });
          runtime.app = app;
        }

        if (config.runtimeRole !== "API" && postgres) {
          const discovery = new SchedulerDiscoveryLoop({
            scheduler: postgres.scheduler,
            createDispatcher: (writer) =>
              new SchedulerDispatcher(writer, postgres.schedulerPorts),
            leases: postgres.leases,
            listDiscoverableRunIds: postgres.listDiscoverableRunIds,
            databaseReachable: () => postgres.db.ping(),
            isAccepting: () => drain.isAcceptingWork(),
            runtimeId: postgres.instanceId,
            workerCapabilities: ["ALL"],
            discoveryBatchSize: Math.min(50, config.workerConcurrency * 10),
            claimBatchSize: config.workerConcurrency,
            onMetric: (name, delta = 1) => metrics.increment(name, delta),
          });
          const claim = new SchedulerClaimLoop({
            scheduler: postgres.scheduler,
            createDispatcher: (writer) =>
              new SchedulerDispatcher(writer, postgres.schedulerPorts),
            leases: postgres.leases,
            listDiscoverableRunIds: postgres.listDiscoverableRunIds,
            databaseReachable: () => postgres.db.ping(),
            isAccepting: () => drain.isAcceptingWork(),
            runtimeId: postgres.instanceId,
            workerCapabilities: ["ALL"],
            discoveryBatchSize: Math.min(50, config.workerConcurrency * 10),
            claimBatchSize: config.workerConcurrency,
            onMetric: (name, delta = 1) => metrics.increment(name, delta),
          });
          worker = new BoundedWorkerLoop({
            concurrency: config.workerConcurrency,
            pollIntervalMs: config.pollIntervalMs,
            jitterMs: config.pollJitterMs,
            isAccepting: () => drain.isAcceptingWork(),
            jobs: [
              {
                name: "outbox",
                run: async () => {
                  const reachable = await postgres.db.ping();
                  if (!reachable) {
                    metrics.increment("worker_database_unavailable");
                    return;
                  }
                  metrics.increment("outbox_claims");
                  const result = await postgres.approvalDeliveryDispatcher.dispatchOnce(
                    config.workerConcurrency,
                  );
                  if (result.failed > 0) {
                    metrics.increment("outbox_retries", result.failed);
                  }
                },
              },
              {
                name: "scheduler-discovery",
                run: async () => {
                  await discovery.tick();
                },
              },
              {
                name: "scheduler-claim",
                run: async () => {
                  await claim.tick();
                },
              },
              {
                name: "program-progression",
                run: async () => {
                  await postgres.programProgression.tick();
                },
              },
              {
                name: "portfolio-progression",
                run: async () => {
                  await postgres.portfolioProgression.tick();
                },
              },
            ],
            onConflict: () => metrics.increment("worker_claim_conflicts"),
          });
          worker.start();
          runtime.worker = worker;
        }

        if (
          (opts.listen ?? true) &&
          config.runtimeRole !== "WORKER" &&
          app
        ) {
          await app.listen({ port: config.httpPort, host: config.httpHost });
        }
        startup.advance("ACCEPTING_TRAFFIC");
        metrics.observe("startup_duration", Date.now() - startedAt);
        logger.log({
          level: "info",
          operation: "runtime.start",
          result: "ready",
          message: "runtime accepting traffic",
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        startup.fail(redactUnknown(error));
        logger.log({
          level: "error",
          operation: "runtime.start",
          result: "failed",
          message: redactUnknown(error),
        });
        throw isRuntimeError(error)
          ? error
          : new RuntimeError("STARTUP_FAILED", redactUnknown(error));
      }
    },
    async close() {
      const drainStarted = Date.now();
      drain.beginDrain();
      if (worker) {
        await worker.waitIdle(config.shutdownGraceMs);
        worker.stop();
      }
      if (app) {
        await app.close();
      }
      drain.stop();
      await boot?.close();
      metrics.observe("shutdown_duration", Date.now() - drainStarted);
      logger.log({
        level: "info",
        operation: "runtime.shutdown",
        result: "stopped",
        message: "runtime stopped",
        durationMs: Date.now() - drainStarted,
      });
    },
  };
  return runtime;
}
