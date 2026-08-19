import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_SCHEMA_VERSION } from "../../domain/durability/index.js";
import { DurabilityError } from "../../durability/errors.js";
import type { PostgresDatabase } from "./database.js";
import { redactUnknown } from "./redact.js";

const ADVISORY_LOCK_KEY = 881_101_1;

export interface MigrationRecord {
  version: string;
  checksum: string;
  appliedAt: string;
}

export function migrationsDirectory(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../migrations");
}

export async function listMigrationFiles(
  directory = migrationsDirectory(),
): Promise<readonly { version: string; filePath: string }[]> {
  const entries = await readdir(directory);
  return entries
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      version: name.replace(/\.sql$/, ""),
      filePath: path.join(directory, name),
    }));
}

export async function checksumFile(filePath: string): Promise<string> {
  const body = await readFile(filePath);
  return createHash("sha256").update(body).digest("hex");
}

export class PostgresMigrationRunner {
  constructor(private readonly db: PostgresDatabase) {}

  async status(): Promise<{
    applied: readonly MigrationRecord[];
    pending: readonly string[];
    current?: string;
    supported: string;
  }> {
    const files = await listMigrationFiles();
    const applied = await this.appliedMigrations();
    const appliedVersions = new Set(applied.map((row) => row.version));
    const pending = files
      .map((file) => file.version)
      .filter((version) => !appliedVersions.has(version));
    const current = applied[applied.length - 1]?.version;
    const result: {
      applied: readonly MigrationRecord[];
      pending: readonly string[];
      current?: string;
      supported: string;
    } = {
      applied,
      pending,
      supported: SUPPORTED_SCHEMA_VERSION,
    };
    if (current !== undefined) {
      result.current = current;
    }
    return result;
  }

  async migrate(): Promise<{ applied: readonly string[] }> {
    const appliedNow: string[] = [];
    await this.withMigrationLock(async () => {
      await this.ensureMigrationsTable();
      const files = await listMigrationFiles();
      const applied = await this.appliedMigrations();
      const byVersion = new Map(applied.map((row) => [row.version, row]));

      for (const file of files) {
        const checksum = await checksumFile(file.filePath);
        const existing = byVersion.get(file.version);
        if (existing) {
          if (existing.checksum !== checksum) {
            throw new DurabilityError(
              "DATABASE_SCHEMA_INCOMPATIBLE",
              `Migration ${file.version} checksum mismatch`,
              { version: file.version },
            );
          }
          continue;
        }
        const sql = await readFile(file.filePath, "utf8");
        await this.db.query(sql);
        await this.db.query(
          `INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)`,
          [file.version, checksum],
        );
        appliedNow.push(file.version);
      }
    });
    return { applied: appliedNow };
  }

  async assertCompatible(): Promise<void> {
    const status = await this.status();
    if (status.pending.length > 0) {
      throw new DurabilityError(
        "DATABASE_SCHEMA_OUT_OF_DATE",
        `Database schema is out of date; pending ${status.pending.join(", ")}`,
        { pending: [...status.pending] },
      );
    }
    const latest = status.applied[status.applied.length - 1];
    if (!latest) {
      throw new DurabilityError(
        "DATABASE_SCHEMA_OUT_OF_DATE",
        "No migrations have been applied",
      );
    }
    if (latest.version !== SUPPORTED_SCHEMA_VERSION) {
      throw new DurabilityError(
        "DATABASE_SCHEMA_INCOMPATIBLE",
        `Schema ${latest.version} is not supported (need ${SUPPORTED_SCHEMA_VERSION})`,
        { current: latest.version, supported: SUPPORTED_SCHEMA_VERSION },
      );
    }
  }

  private async appliedMigrations(): Promise<MigrationRecord[]> {
    try {
      const result = await this.db.query<{
        version: string;
        checksum: string;
        applied_at: Date;
      }>(
        `SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version ASC`,
      );
      return result.rows.map((row) => ({
        version: row.version,
        checksum: row.checksum,
        appliedAt: row.applied_at.toISOString(),
      }));
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "details" in error
          ? String(
              (error as { details?: { pgCode?: unknown } }).details?.pgCode ??
                "",
            )
          : "";
      const message = redactUnknown(error);
      if (message.includes("does not exist") || code === "42P01") {
        return [];
      }
      throw error;
    }
  }

  private async ensureMigrationsTable(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  private async withMigrationLock<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const locked = await this.db.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock($1) AS locked`,
        [ADVISORY_LOCK_KEY],
      );
      if (!locked.rows[0]?.locked) {
        const waited = await this.db.query<{ locked: boolean }>(
          `SELECT pg_advisory_lock($1) IS NOT NULL AS locked`,
          [ADVISORY_LOCK_KEY],
        );
        if (!waited.rows[0]?.locked) {
          throw new DurabilityError(
            "MIGRATION_LOCK_UNAVAILABLE",
            "Could not acquire PostgreSQL migration lock",
          );
        }
      }
      return await fn();
    } finally {
      try {
        await this.db.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]);
      } catch {
        // shutdown path
      }
    }
  }
}
