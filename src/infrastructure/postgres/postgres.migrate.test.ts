import { describe, expect, it } from "vitest";
import { SUPPORTED_SCHEMA_VERSION } from "../../domain/durability/index.js";
import { PostgresDatabase } from "./database.js";
import { PostgresMigrationRunner } from "./migrate.js";
import {
  createTestDatabase,
  requireTestDatabaseUrl,
  uniquePostgresTestId,
} from "./test-helpers.js";

describe("PostgreSQL migration compatibility", () => {
  it("createTestDatabase migrate + assertCompatible accepts 015", async () => {
    const db = await createTestDatabase(
      uniquePostgresTestId("schema_015_compatible"),
    );
    try {
      const runner = new PostgresMigrationRunner(db);
      const status = await runner.status();
      expect(status.supported).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(status.current).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(status.pending).toEqual([]);
      await runner.assertCompatible();
    } finally {
      await db.close();
    }
  });

  it("database at 014 migrates forward to 015 then becomes compatible", async () => {
    const db = new PostgresDatabase({
      connectionString: requireTestDatabaseUrl(),
      max: 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
      instanceId: uniquePostgresTestId("schema_014_forward"),
    });
    try {
      const runner = new PostgresMigrationRunner(db);
      await runner.migrate();
      await db.query(
        `DELETE FROM schema_migrations WHERE version = $1`,
        [SUPPORTED_SCHEMA_VERSION],
      );
      const before = await runner.status();
      expect(before.current).toBe("014_phase19_decision_policy_optimization");
      expect(before.pending).toContain(SUPPORTED_SCHEMA_VERSION);

      await expect(runner.assertCompatible()).rejects.toMatchObject({
        code: "DATABASE_SCHEMA_OUT_OF_DATE",
      });

      const { applied } = await runner.migrate();
      expect(applied).toContain(SUPPORTED_SCHEMA_VERSION);

      const after = await runner.status();
      expect(after.current).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(after.pending).toEqual([]);
      await runner.assertCompatible();
    } finally {
      await db.close();
    }
  });

  it("rejects unknown newer schema versions fail closed", async () => {
    const db = new PostgresDatabase({
      connectionString: requireTestDatabaseUrl(),
      max: 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
      instanceId: uniquePostgresTestId("schema_future_reject"),
    });
    const futureVersion = "016_phase21_unknown_future";
    try {
      const runner = new PostgresMigrationRunner(db);
      await runner.migrate();
      await db.query(
        `INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)`,
        [futureVersion, "0".repeat(64)],
      );
      await expect(runner.assertCompatible()).rejects.toMatchObject({
        code: "DATABASE_SCHEMA_INCOMPATIBLE",
      });
    } finally {
      await db.query(`DELETE FROM schema_migrations WHERE version = $1`, [
        futureVersion,
      ]);
      await db.close();
    }
  });

  it("health readiness reports the same supported schema version", async () => {
    const { PostgresHealthService } = await import("./health.js");
    const db = await createTestDatabase(
      uniquePostgresTestId("schema_health_supported"),
    );
    try {
      const health = await new PostgresHealthService(db, "postgres").readiness();
      expect(health.supportedSchemaVersion).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(health.schemaCompatible).toBe(true);
    } finally {
      await db.close();
    }
  });
});
