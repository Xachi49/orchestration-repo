import Fastify from "fastify";

/**
 * Minimal HTTP surface for Phase 0.
 * Exposes health only — no orchestration endpoints yet.
 */
export async function buildServer() {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({
    status: "ok",
    phase: 1,
    orchestrator: "foundation",
    llmConnected: false,
    githubConnected: false,
    executionEnabled: false,
  }));

  return app;
}

async function main(): Promise<void> {
  const app = await buildServer();
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
