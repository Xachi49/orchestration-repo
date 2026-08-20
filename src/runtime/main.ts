import { createOrchestratorRuntime } from "./process.js";

async function main(): Promise<void> {
  const runtime = createOrchestratorRuntime();
  await runtime.start();
  const shutdown = async () => {
    await runtime.close();
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
  (process.argv[1].endsWith("main.ts") || process.argv[1].endsWith("main.js"));

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
