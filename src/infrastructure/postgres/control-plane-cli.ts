#!/usr/bin/env node
/**
 * Operator-only control-plane CLI.
 *
 * CONTROL-PLANE PROVISIONING != OUTREACH AUTHORIZATION
 * Never seeds EXAMPLE_PROJECT. Never mutates without --apply.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadStorageConfig } from "./config.js";
import { PostgresDatabase } from "./database.js";
import { redactUnknown } from "./redact.js";
import {
  ControlPlaneOpsService,
  isControlPlaneProvisionError,
} from "./control-plane-ops.js";

function usage(): string {
  return `Usage:
  node dist/infrastructure/postgres/control-plane-cli.js inspect --project-id <id>
  node dist/infrastructure/postgres/control-plane-cli.js provision --manifest <path> --dry-run
  node dist/infrastructure/postgres/control-plane-cli.js provision --manifest <path> --apply --operator-id <id>

Requires DATABASE_URL and ORCHESTRATOR_STORAGE=postgres (or forces postgres).
Default provision mode is non-mutating; --apply is required to write.
--apply requires --operator-id (non-secret; recorded in durable provisioning audit).
`;
}

function parseArgs(argv: string[]): {
  command: string;
  projectId?: string;
  manifestPath?: string;
  operatorId?: string;
  dryRun: boolean;
  apply: boolean;
} {
  const command = argv[0] ?? "";
  let projectId: string | undefined;
  let manifestPath: string | undefined;
  let operatorId: string | undefined;
  let dryRun = false;
  let apply = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-id") {
      projectId = argv[++i];
      continue;
    }
    if (arg === "--manifest") {
      manifestPath = argv[++i];
      continue;
    }
    if (arg === "--operator-id") {
      operatorId = argv[++i];
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  const result: {
    command: string;
    projectId?: string;
    manifestPath?: string;
    operatorId?: string;
    dryRun: boolean;
    apply: boolean;
  } = { command, dryRun, apply };
  if (projectId !== undefined) result.projectId = projectId;
  if (manifestPath !== undefined) result.manifestPath = manifestPath;
  if (operatorId !== undefined) result.operatorId = operatorId;
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== "inspect" && args.command !== "provision") {
    process.stderr.write(usage());
    process.exitCode = 1;
    return;
  }

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
    const ops = new ControlPlaneOpsService(db);
    if (args.command === "inspect") {
      if (!args.projectId) {
        throw new Error(`--project-id is required\n${usage()}`);
      }
      const result = await ops.inspect(args.projectId);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (!args.manifestPath) {
      throw new Error(`--manifest is required\n${usage()}`);
    }
    if (args.dryRun && args.apply) {
      throw new Error("--dry-run and --apply are mutually exclusive");
    }
    if (!args.dryRun && !args.apply) {
      throw new Error(
        "Provision is non-mutating by default; pass --dry-run or --apply",
      );
    }
    if (args.apply && !args.operatorId?.trim()) {
      throw new Error(`--apply requires --operator-id\n${usage()}`);
    }
    const raw = JSON.parse(
      readFileSync(resolve(args.manifestPath), "utf8"),
    ) as unknown;
    const result = await ops.provision({
      manifest: raw,
      mode: args.apply ? "apply" : "dry-run",
      ...(args.operatorId !== undefined
        ? { operatorId: args.operatorId }
        : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.conflicts.length > 0) {
      process.exitCode = 2;
    }
  } catch (error) {
    if (isControlPlaneProvisionError(error)) {
      process.stderr.write(
        `${JSON.stringify(
          {
            error: error.code,
            message: error.message,
            conflicts: error.conflicts ?? [],
          },
          null,
          2,
        )}\n`,
      );
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`${redactUnknown(error)}\n`);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

await main();
