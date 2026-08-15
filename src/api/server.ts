import Fastify from "fastify";
import type { ObjectiveAdmissionService } from "../admission/service.js";
import type { RepositoryTruthService } from "../ingestion/service.js";
import { registerRunRoutes } from "./runs.js";
import { registerIngestRoutes } from "./ingest.js";
import { createLocalIngestionStack } from "../infrastructure/ingestion/local-stack.js";

export interface ApiDeps {
  admission?: ObjectiveAdmissionService;
  ingestion?: RepositoryTruthService;
}

/**
 * HTTP surface. Business logic lives in application services.
 */
export async function buildServer(deps: ApiDeps = {}) {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({
    status: "ok",
    phase: 3,
    orchestrator: "repository-truth",
    llmConnected: false,
    githubConnected: false,
    githubWritesEnabled: false,
    executionEnabled: false,
  }));

  if (deps.admission) {
    registerRunRoutes(app, deps.admission);
  }
  if (deps.ingestion) {
    registerIngestRoutes(app, deps.ingestion);
  }

  return app;
}

async function main(): Promise<void> {
  const stack = createLocalIngestionStack();
  const app = await buildServer({
    admission: stack.admission,
    ingestion: stack.ingestion,
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
