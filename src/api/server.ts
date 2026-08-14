import Fastify from "fastify";
import type { ObjectiveAdmissionService } from "../admission/service.js";
import { registerRunRoutes } from "./runs.js";
import { createLocalAdmissionStack } from "../infrastructure/admission/local-stack.js";

export interface ApiDeps {
  admission?: ObjectiveAdmissionService;
}

/**
 * HTTP surface. Business logic lives in ObjectiveAdmissionService.
 */
export async function buildServer(deps: ApiDeps = {}) {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({
    status: "ok",
    phase: 2,
    orchestrator: "admission",
    llmConnected: false,
    githubConnected: false,
    executionEnabled: false,
  }));

  if (deps.admission) {
    registerRunRoutes(app, deps.admission);
  }

  return app;
}

async function main(): Promise<void> {
  const stack = createLocalAdmissionStack();
  const app = await buildServer({ admission: stack.service });
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
