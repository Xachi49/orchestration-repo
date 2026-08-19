import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseStorageMode, loadStorageConfig } from "./config.js";
import { redactDatabaseUrl } from "./redact.js";
import { DurabilityError } from "../../durability/errors.js";
import { isInTransaction, assertNotInTransaction } from "../../durability/transaction.js";

describe("storage mode", () => {
  it("defaults to memory", () => {
    expect(parseStorageMode(undefined)).toBe("memory");
  });

  it("rejects unknown modes", () => {
    expect(() => parseStorageMode("redis")).toThrow(DurabilityError);
  });

  it("does not fall back from postgres to memory when DATABASE_URL is missing", () => {
    expect(() =>
      loadStorageConfig({ ORCHESTRATOR_STORAGE: "postgres" }),
    ).toThrow(/DATABASE_URL/);
  });
});

describe("credential redaction", () => {
  it("redacts passwords in DATABASE_URL", () => {
    expect(
      redactDatabaseUrl("postgres://user:s3cret@localhost:5432/orchestrator"),
    ).toBe("postgres://user:***@localhost:5432/orchestrator");
  });
});

describe("transaction guard", () => {
  it("is not in a transaction by default", () => {
    expect(isInTransaction()).toBe(false);
    expect(() => assertNotInTransaction("SafeActuator")).not.toThrow();
  });
});
