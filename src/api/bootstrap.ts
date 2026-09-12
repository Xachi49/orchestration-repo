import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";
import { bootstrapOrchestratorStack } from "../infrastructure/bootstrap.js";
import type { LocalObservabilityStack } from "../infrastructure/observability/local-stack.js";
import type { PostgresOrchestratorStack } from "../infrastructure/postgres/stack.js";
import { controlTowerFromStack } from "./control-tower-factory.js";
import { FakeApprovalDeliveryService } from "../authorization/delivery.js";

export interface RunningServer {
  app: FastifyInstance;
  close: () => Promise<void>;
}

function apiDepsFromStack(
  stack: PostgresOrchestratorStack | LocalObservabilityStack,
) {
  return {
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
    verification: stack.verification,
    verificationReadiness: stack.verificationReadiness,
    memory: stack.memory,
    observability: stack.observability,
    runs: stack.runs,
    controlTower: controlTowerFromStack(stack),
    // bootstrap/startOrchestratorServer is a local harness (not PRODUCTION process).
    controlTowerOptions: {
      allowLocalDelivery:
        stack.approvalDelivery instanceof FakeApprovalDeliveryService,
      authenticationMode: "ANONYMOUS" as const,
      runtimeEnvironment: "DEVELOPMENT",
      // Fail closed by default. Explicit env fixture only.
      controlTowerDevAllowAll:
        process.env["ORCHESTRATOR_CONTROL_TOWER_DEV_ALLOW_ALL"] === "1" ||
        process.env["ORCHESTRATOR_CONTROL_TOWER_DEV_ALLOW_ALL"] === "true",
    },
  };
}

export async function startOrchestratorServer(
  port = 3000,
): Promise<RunningServer> {
  const boot = await bootstrapOrchestratorStack();
  const app = await buildServer({
    ...apiDepsFromStack(boot.stack),
    storageMode: boot.storageMode,
    ...(boot.health ? { readiness: boot.health } : {}),
  });
  await app.listen({ port, host: "127.0.0.1" });
  return {
    app,
    close: async () => {
      await app.close();
      await boot.close();
    },
  };
}
