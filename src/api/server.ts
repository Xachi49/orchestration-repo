import type { ObjectiveAdmissionService } from "../admission/service.js";
import type { RepositoryTruthService } from "../ingestion/service.js";
import type { PlanningService } from "../planning/service.js";
import type { ValidationService } from "../validation/service.js";
import type { AuthorizationRoutingService } from "../authorization/routing.js";
import type { HumanAuthorizationService } from "../authorization/service.js";
import type { ApprovalExpiryService } from "../authorization/expiry.js";
import type { AuthorizationReadinessService } from "../authorization/readiness.js";
import type { ExecutionService } from "../execution/service.js";
import type { ExecutionReadinessService } from "../execution/readiness.js";
import type { OutcomeVerificationService } from "../verification/service.js";
import type { VerificationReadinessService } from "../verification/readiness.js";
import type { GovernedMemoryService } from "../memory/service.js";
import type { ObservabilityService } from "../observability/service.js";
import type { StorageMode } from "../domain/durability/index.js";
import Fastify from "fastify";
import { registerRunRoutes } from "./runs.js";
import { registerIngestRoutes } from "./ingest.js";
import { registerPlanRoutes } from "./plan.js";
import { registerValidationRoutes } from "./validate.js";
import { registerAuthorizationRoutes } from "./authorize.js";
import { registerExecutionRoutes } from "./execute.js";
import { registerVerificationRoutes } from "./verify.js";
import { registerLearningRoutes } from "./learn.js";
import { registerObservabilityRoutes } from "./observability.js";

export interface ApiDeps {
  admission?: ObjectiveAdmissionService;
  ingestion?: RepositoryTruthService;
  planning?: PlanningService;
  validation?: ValidationService;
  authorizationRouting?: AuthorizationRoutingService;
  humanAuthorization?: HumanAuthorizationService;
  approvalExpiry?: ApprovalExpiryService;
  authorizationReadiness?: AuthorizationReadinessService;
  execution?: ExecutionService;
  executionReadiness?: ExecutionReadinessService;
  verification?: OutcomeVerificationService;
  verificationReadiness?: VerificationReadinessService;
  memory?: GovernedMemoryService;
  observability?: ObservabilityService;
  storageMode?: StorageMode;
  readiness?: {
    storageMode: StorageMode;
    databaseReachable: boolean;
    schemaCompatible: boolean;
    schemaVersion?: string;
    supportedSchemaVersion: string;
  };
}

/**
 * HTTP surface. Business logic lives in application services.
 */
export async function buildServer(deps: ApiDeps = {}) {
  const app = Fastify({ logger: false });

  const approvalEnabled = Boolean(
    deps.authorizationRouting && deps.humanAuthorization,
  );
  const executionEnabled = Boolean(deps.execution);
  const verificationEnabled = Boolean(deps.verification);
  const memoryEnabled = Boolean(deps.memory);
  const observabilityEnabled = Boolean(deps.observability);

  app.get("/health", async () => ({
    status: "ok",
    phase: observabilityEnabled
      ? 11
      : memoryEnabled
        ? 9
        : verificationEnabled
          ? 8
          : executionEnabled
            ? 7
            : 6,
    orchestrator: observabilityEnabled
      ? "observability"
      : memoryEnabled
        ? "memory"
        : verificationEnabled
          ? "verification"
          : executionEnabled
            ? "execution"
            : approvalEnabled
              ? "authorization"
              : deps.validation
                ? "validation"
                : "planning",
    llmConnected: false,
    githubConnected: false,
    githubWritesEnabled: false,
    executionEnabled,
    verificationEnabled,
    memoryEnabled,
    observabilityEnabled,
    approvalEnabled,
    storageMode: deps.storageMode ?? "memory",
    databaseReachable: deps.readiness?.databaseReachable ?? null,
    schemaCompatible: deps.readiness?.schemaCompatible ?? null,
    schemaVersion: deps.readiness?.schemaVersion ?? null,
    supportedSchemaVersion: deps.readiness?.supportedSchemaVersion ?? null,
    planningModelToolsEnabled: false,
    validationModelToolsEnabled: false,
    verificationModelToolsEnabled: false,
    learningModelToolsEnabled: false,
  }));

  if (deps.admission) {
    registerRunRoutes(app, deps.admission);
  }
  if (deps.ingestion) {
    registerIngestRoutes(app, deps.ingestion);
  }
  if (deps.planning) {
    registerPlanRoutes(app, deps.planning);
  }
  if (deps.validation) {
    registerValidationRoutes(app, deps.validation);
  }
  if (
    deps.authorizationRouting &&
    deps.humanAuthorization &&
    deps.approvalExpiry &&
    deps.authorizationReadiness
  ) {
    registerAuthorizationRoutes(app, {
      routing: deps.authorizationRouting,
      humanAuthorization: deps.humanAuthorization,
      expiry: deps.approvalExpiry,
      readiness: deps.authorizationReadiness,
    });
  }
  if (deps.execution && deps.executionReadiness) {
    registerExecutionRoutes(app, {
      execution: deps.execution,
      readiness: deps.executionReadiness,
    });
  }
  if (deps.verification && deps.verificationReadiness) {
    registerVerificationRoutes(app, {
      verification: deps.verification,
      readiness: deps.verificationReadiness,
    });
  }
  if (deps.memory) {
    registerLearningRoutes(app, { memory: deps.memory });
  }
  if (deps.observability) {
    registerObservabilityRoutes(app, { observability: deps.observability });
  }

  return app;
}

import { startOrchestratorServer } from "./bootstrap.js";

async function main(): Promise<void> {
  const port = Number(process.env["PORT"] ?? 3000);
  const running = await startOrchestratorServer(port);
  const shutdown = async () => {
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("server.ts") ||
    process.argv[1].endsWith("server.js"));

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
