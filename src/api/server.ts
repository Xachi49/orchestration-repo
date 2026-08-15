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
import Fastify from "fastify";
import { registerRunRoutes } from "./runs.js";
import { registerIngestRoutes } from "./ingest.js";
import { registerPlanRoutes } from "./plan.js";
import { registerValidationRoutes } from "./validate.js";
import { registerAuthorizationRoutes } from "./authorize.js";
import { registerExecutionRoutes } from "./execute.js";
import { createLocalExecutionStack } from "../infrastructure/execution/local-stack.js";

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

  app.get("/health", async () => ({
    status: "ok",
    phase: executionEnabled ? 7 : 6,
    orchestrator: executionEnabled
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
    approvalEnabled,
    planningModelToolsEnabled: false,
    validationModelToolsEnabled: false,
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

  return app;
}

async function main(): Promise<void> {
  const stack = createLocalExecutionStack();
  const app = await buildServer({
    admission: stack.admission,
    ingestion: stack.ingestion,
    planning: stack.planning,
    validation: stack.validation,
    authorizationRouting: stack.authorizationRouting,
    humanAuthorization: stack.humanAuthorization,
    approvalExpiry: stack.approvalExpiry,
    authorizationReadiness: stack.authorizationReadiness,
    execution: stack.execution,
    executionReadiness: stack.executionReadiness,
  });
  const port = Number(process.env["PORT"] ?? 3000);
  await app.listen({ port, host: "127.0.0.1" });
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
