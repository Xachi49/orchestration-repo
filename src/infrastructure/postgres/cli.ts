import { loadStorageConfig } from "./config.js";
import { PostgresDatabase } from "./database.js";
import { PostgresMigrationRunner } from "./migrate.js";
import { redactUnknown } from "./redact.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  const config = loadStorageConfig({
    ...process.env,
    ORCHESTRATOR_STORAGE: "postgres",
  });
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const db = new PostgresDatabase({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    instanceId: config.instanceId,
  });
  try {
    const runner = new PostgresMigrationRunner(db);
    if (command === "migrate") {
      const result = await runner.migrate();
      process.stdout.write(
        `applied: ${result.applied.length ? result.applied.join(", ") : "(none)"}\n`,
      );
      return;
    }
    const status = await runner.status();
    process.stdout.write(
      JSON.stringify(
        {
          current: status.current ?? null,
          pending: status.pending,
          supported: status.supported,
          applied: status.applied.map((row) => row.version),
        },
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    process.stderr.write(`${redactUnknown(error)}\n`);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

await main();
