import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUPPORTED_SCHEMA_VERSION } from "../../domain/durability/index.js";
import { listMigrationFiles } from "./migrate.js";

describe("schema migration catalog", () => {
  it("declares the latest migration file as SUPPORTED_SCHEMA_VERSION", async () => {
    const files = await listMigrationFiles();
    const latest = files[files.length - 1];
    expect(latest).toBeDefined();
    expect(latest!.version).toBe(SUPPORTED_SCHEMA_VERSION);
    expect(SUPPORTED_SCHEMA_VERSION).toBe(
      "015_phase20_institutional_governance",
    );
  });

  it("keeps phase migrations 013–015 in order without gaps or duplicates", async () => {
    const files = await listMigrationFiles();
    const versions = files.map((file) => file.version);
    const phaseTail = [
      "013_phase18_causal_intelligence",
      "014_phase19_decision_policy_optimization",
      "015_phase20_institutional_governance",
    ];
    for (let i = 0; i < phaseTail.length; i++) {
      const expected = phaseTail[i]!;
      const index = versions.indexOf(expected);
      expect(index).toBeGreaterThanOrEqual(0);
      if (i > 0) {
        const prev = phaseTail[i - 1]!;
        expect(versions.indexOf(prev)).toBeLessThan(index);
      }
    }
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("migrate and health import SUPPORTED_SCHEMA_VERSION from one canonical constant", () => {
    const migrateBody = readFileSync(
      "src/infrastructure/postgres/migrate.ts",
      "utf8",
    );
    const healthBody = readFileSync(
      "src/infrastructure/postgres/health.ts",
      "utf8",
    );
    const bootstrapBody = readFileSync(
      "src/infrastructure/bootstrap.ts",
      "utf8",
    );
    expect(migrateBody).toContain("SUPPORTED_SCHEMA_VERSION");
    expect(healthBody).toContain("SUPPORTED_SCHEMA_VERSION");
    expect(bootstrapBody).toContain("assertCompatible");
    expect(migrateBody).not.toContain(
      "014_phase19_decision_policy_optimization",
    );
  });
});
