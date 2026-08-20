import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "./config.js";
import { RuntimeError } from "./errors.js";
import { redactText } from "./logging.js";

const productionBase = {
  ORCHESTRATOR_ENV: "PRODUCTION",
  ORCHESTRATOR_STORAGE: "postgres",
  DATABASE_URL: "postgres://orchestrator:secret@127.0.0.1:5432/orchestrator",
  ORCHESTRATOR_AUTH_MODE: "HEADER_PRINCIPAL",
  APPROVAL_DELIVERY_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
  ORCHESTRATOR_DEBUG: "false",
  ORCHESTRATOR_WORKER_CONCURRENCY: "4",
};

describe("production runtime configuration", () => {
  it("accepts a valid PRODUCTION config without logging secrets", () => {
    const config = loadRuntimeConfig(productionBase);
    expect(config.runtimeEnvironment).toBe("PRODUCTION");
    expect(config.storageMode).toBe("postgres");
    expect(config.authenticationMode).toBe("HEADER_PRINCIPAL");
    expect(redactText(String(config.databaseUrl))).not.toContain("secret");
  });

  it("rejects MEMORY storage in PRODUCTION", () => {
    expect(() =>
      loadRuntimeConfig({
        ...productionBase,
        ORCHESTRATOR_STORAGE: "memory",
      }),
    ).toThrow(RuntimeError);
  });

  it("rejects missing DATABASE_URL in PRODUCTION", () => {
    const env = { ...productionBase };
    delete env.DATABASE_URL;
    expect(() => loadRuntimeConfig(env)).toThrow(/DATABASE_URL/);
  });

  it("rejects anonymous auth in PRODUCTION", () => {
    expect(() =>
      loadRuntimeConfig({
        ...productionBase,
        ORCHESTRATOR_AUTH_MODE: "ANONYMOUS",
      }),
    ).toThrow(/anonymous/i);
  });

  it("rejects missing delivery secret in PRODUCTION", () => {
    const env = { ...productionBase };
    delete env.APPROVAL_DELIVERY_SECRET_KEY;
    expect(() => loadRuntimeConfig(env)).toThrow(/APPROVAL_DELIVERY_SECRET_KEY/);
  });

  it("rejects debug mode in PRODUCTION", () => {
    expect(() =>
      loadRuntimeConfig({
        ...productionBase,
        ORCHESTRATOR_DEBUG: "true",
      }),
    ).toThrow(/debug/i);
  });

  it("rejects invalid worker concurrency", () => {
    expect(() =>
      loadRuntimeConfig({
        ...productionBase,
        ORCHESTRATOR_WORKER_CONCURRENCY: "0",
      }),
    ).toThrow();
  });

  it("rejects unknown runtime environment", () => {
    expect(() =>
      loadRuntimeConfig({
        ...productionBase,
        ORCHESTRATOR_ENV: "CANARY",
      }),
    ).toThrow(/Unknown runtime environment/);
  });

  it("allows memory storage in TEST", () => {
    const config = loadRuntimeConfig({
      ORCHESTRATOR_ENV: "TEST",
      ORCHESTRATOR_STORAGE: "memory",
      ORCHESTRATOR_AUTH_MODE: "ANONYMOUS",
    });
    expect(config.storageMode).toBe("memory");
  });
});
