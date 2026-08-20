import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import type { PostgresDatabase } from "./database.js";
import { requireTestDatabaseUrl } from "./test-helpers.js";

export function rewriteDatabaseUrl(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

export function adminDatabaseUrl(url: string): string {
  return rewriteDatabaseUrl(url, "postgres");
}

export function pgDumpToolsAvailable(): boolean {
  try {
    execFileSync("pg_dump", ["--version"], { stdio: "ignore" });
    execFileSync("pg_restore", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function assertSafeDatabaseName(name: string): void {
  if (!/^p12[a-z0-9_]+$/.test(name)) {
    throw new Error(`refusing unsafe disposable database name ${name}`);
  }
}

export async function createDisposableDatabase(name: string): Promise<{
  name: string;
  url: string;
  drop: () => Promise<void>;
}> {
  assertSafeDatabaseName(name);
  const source = requireTestDatabaseUrl();
  const admin = new pg.Client({ connectionString: adminDatabaseUrl(source) });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  return {
    name,
    url: rewriteDatabaseUrl(source, name),
    drop: async () => {
      try {
        await admin.query(
          `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [name],
        );
        await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      } finally {
        await admin.end().catch(() => undefined);
      }
    },
  };
}

export function dumpAndRestoreWithPgDump(
  sourceUrl: string,
  destUrl: string,
): void {
  const dir = mkdtempSync(path.join(tmpdir(), "p12-dump-"));
  const file = path.join(dir, "orchestrator.dump");
  try {
    execFileSync(
      "pg_dump",
      ["--format=custom", "--no-owner", `--file=${file}`, sourceUrl],
      { stdio: "pipe" },
    );
    execFileSync("pg_restore", ["--no-owner", `--dbname=${destUrl}`, file], {
      stdio: "pipe",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error(`unsafe identifier ${name}`);
  }
  return `"${name}"`;
}

/**
 * pg_dump-compatible logical copy used when client binaries are absent.
 * Copies public tables into an already-migrated destination database.
 */
export async function copyPublicTables(
  source: PostgresDatabase,
  dest: PostgresDatabase,
): Promise<void> {
  const tables = await source.query<{ tablename: string }>(
    `SELECT tablename
     FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename NOT IN ('schema_migrations', 'migration_lock')
     ORDER BY tablename`,
  );
  for (const { tablename } of tables.rows) {
    const rows = await source.query(`SELECT * FROM ${quoteIdent(tablename)}`);
    if (rows.rows.length === 0) {
      continue;
    }
    const cols = Object.keys(rows.rows[0]!);
    const colSql = cols.map(quoteIdent).join(", ");
    for (const row of rows.rows) {
      const values = cols.map((col) => row[col]);
      const placeholders = cols.map((_, index) => `$${index + 1}`).join(", ");
      try {
        await dest.query(
          `INSERT INTO ${quoteIdent(tablename)} (${colSql})
           VALUES (${placeholders})`,
          values,
        );
      } catch (error) {
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : undefined;
        if (code !== "DURABLE_CONFLICT") {
          throw error;
        }
      }
    }
  }
}
