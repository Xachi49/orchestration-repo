import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { PostgresDatabase, isNormalizedApplicationError } from "./database.js";
import { ApprovedPlanRepairError } from "../../planning/approved-plan-repair.js";
import { RevenueRecoveryError } from "../../revenue-recovery/errors.js";
import { DurabilityError } from "../../durability/errors.js";

function databaseWithFakeClient(): { db: PostgresDatabase; statements: string[] } {
  const db = new PostgresDatabase({
    connectionString: "postgres://unused:unused@127.0.0.1:1/unused",
    max: 1,
    connectionTimeoutMillis: 10,
    idleTimeoutMillis: 10,
    instanceId: "db_unit",
  });
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  } as unknown as pg.PoolClient;
  vi.spyOn(db.pool, "connect").mockImplementation(async () => client);
  return { db, statements };
}

describe("PostgresDatabase transaction error normalization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves ApprovedPlanRepairError so the route can map REPAIR_BINDING_FAILED to 409", async () => {
    const { db, statements } = databaseWithFakeClient();
    const error = new ApprovedPlanRepairError(
      "REPAIR_BINDING_FAILED",
      "No enabled EMAIL template for recovery case tenant/project",
      { binderCode: "RECOVERY_TEMPLATE_UNRESOLVED" },
    );
    await expect(
      db.withTransaction(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
    await db.close();
  });

  it("preserves RevenueRecoveryError thrown inside a transaction", async () => {
    const { db } = databaseWithFakeClient();
    const error = new RevenueRecoveryError(
      "RECOVERY_TEMPLATE_IDENTITY_CONFLICT",
      "Another enabled template identity already exists",
    );
    await expect(
      db.withTransaction(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    await db.close();
  });

  it("still wraps unknown errors as DATABASE_TRANSACTION_FAILED", async () => {
    const { db } = databaseWithFakeClient();
    await expect(
      db.withTransaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toMatchObject({
      name: "DurabilityError",
      code: "DATABASE_TRANSACTION_FAILED",
    });
    await db.close();
  });

  it("classifies only named deterministic domain errors as normalized", () => {
    expect(
      isNormalizedApplicationError(
        new ApprovedPlanRepairError("REPAIR_BINDING_FAILED", "x"),
      ),
    ).toBe(true);
    expect(
      isNormalizedApplicationError(new RevenueRecoveryError("TEMPLATE_INVALID", "x")),
    ).toBe(true);
    expect(
      isNormalizedApplicationError(
        new DurabilityError("DATABASE_TRANSACTION_FAILED", "x"),
      ),
    ).toBe(true);
    expect(isNormalizedApplicationError(new Error("x"))).toBe(false);
    expect(isNormalizedApplicationError("ApprovedPlanRepairError")).toBe(false);
  });
});
