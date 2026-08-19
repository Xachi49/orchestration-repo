import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";
import { bootstrapOrchestratorStack } from "../infrastructure/bootstrap.js";
import type { LocalObservabilityStack } from "../infrastructure/observability/local-stack.js";
import type { PostgresOrchestratorStack } from "../infrastructure/postgres/stack.js";

export interface RunningServer {
  app: FastifyInstance;
  close: () => Promise<void>;
}

function apiDepsFromStack(stack: PostgresOrchestratorStack | LocalObservabilityStack) {
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
  };
}

export async function startOrchestratorServer(port = 3000): Promise<RunningServer> {
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
