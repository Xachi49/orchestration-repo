import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "./config.js";
import { RuntimeError } from "./errors.js";
import { redactText } from "./logging.js";

const productionBase = {
  ORCHESTRATOR_ENV: "PRODUCTION",
  ORCHESTRATOR_STORAGE: "postgres",
  DATABASE_URL: "postgres://orchestrator:secret@127.0.0.1:5432/orchestrator",
  ORCHESTRATOR_AUTH_MODE: "STATIC_PRINCIPAL",
  ORCHESTRATOR_STATIC_PRINCIPAL_ID: "operator_static",
  APPROVAL_DELIVERY_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
  RECOVERY_PROVIDER_MODE: "SHADOW",
  ORCHESTRATOR_GITHUB_AUTH_MODE: "TOKEN",
  GITHUB_TOKEN: "ghs_test_token_not_a_secret_fixture",
  ORCHESTRATOR_MODEL_PROVIDER: "openai",
  OPENAI_API_KEY: "sk-test-fixture-not-a-secret",
  ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER: "resend",
  RESEND_API_KEY: "re_test_fixture_not_a_secret",
  APPROVAL_DELIVERY_EMAIL_FROM: "orchestrator@example.com",
  APPROVAL_DELIVERY_EMAIL_TO: "approvers@example.com",
  ORCHESTRATOR_DEBUG: "false",
  ORCHESTRATOR_WORKER_CONCURRENCY: "4",
};

describe("production runtime configuration", () => {
  it("accepts a valid PRODUCTION config without logging secrets", () => {
    const config = loadRuntimeConfig(productionBase);
    expect(config.runtimeEnvironment).toBe("PRODUCTION");
    expect(config.storageMode).toBe("postgres");
    expect(config.authenticationMode).toBe("STATIC_PRINCIPAL");
    expect(redactText(String(config.databaseUrl))).not.toContain("secret");
  });

  it("rejects header-only principal authentication in PRODUCTION", () => {
    expect(() =>
      loadRuntimeConfig({
        ...productionBase,
        ORCHESTRATOR_AUTH_MODE: "HEADER_PRINCIPAL",
      }),
    ).toThrow(/HEADER_PRINCIPAL|x-orchestrator-principal|DEVELOPMENT AUTH/i);
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

  it("rejects missing RECOVERY_PROVIDER_MODE in PRODUCTION", () => {
    const env = { ...productionBase };
    delete env.RECOVERY_PROVIDER_MODE;
    expect(() => loadRuntimeConfig(env)).toThrow(/RECOVERY_PROVIDER_MODE/);
  });

  it("rejects missing ORCHESTRATOR_GITHUB_AUTH_MODE in PRODUCTION", () => {
    const env = { ...productionBase };
    delete (env as { ORCHESTRATOR_GITHUB_AUTH_MODE?: string })
      .ORCHESTRATOR_GITHUB_AUTH_MODE;
    expect(() => loadRuntimeConfig(env)).toThrow(/ORCHESTRATOR_GITHUB_AUTH_MODE/);
  });

  it("rejects invalid ORCHESTRATOR_GITHUB_AUTH_MODE in PRODUCTION", () => {
    expect(() =>
      loadRuntimeConfig({
        ...productionBase,
        ORCHESTRATOR_GITHUB_AUTH_MODE: "AUTO",
      }),
    ).toThrow(/ORCHESTRATOR_GITHUB_AUTH_MODE/);
  });

  it("rejects missing GITHUB_TOKEN when auth mode is TOKEN", () => {
    const env = { ...productionBase };
    delete (env as { GITHUB_TOKEN?: string }).GITHUB_TOKEN;
    expect(() => loadRuntimeConfig(env)).toThrow(/GITHUB_TOKEN/);
  });

  it("accepts PUBLIC_ANONYMOUS without GITHUB_TOKEN", () => {
    const env = {
      ...productionBase,
      ORCHESTRATOR_GITHUB_AUTH_MODE: "PUBLIC_ANONYMOUS",
    };
    delete (env as { GITHUB_TOKEN?: string }).GITHUB_TOKEN;
    const config = loadRuntimeConfig(env);
    expect(config.runtimeEnvironment).toBe("PRODUCTION");
  });

  it("rejects missing ORCHESTRATOR_MODEL_PROVIDER in PRODUCTION", () => {
    const env = { ...productionBase };
    delete (env as { ORCHESTRATOR_MODEL_PROVIDER?: string })
      .ORCHESTRATOR_MODEL_PROVIDER;
    expect(() => loadRuntimeConfig(env)).toThrow(/ORCHESTRATOR_MODEL_PROVIDER/);
  });

  it("rejects fake planning provider in PRODUCTION", () => {
    expect(() =>
      loadRuntimeConfig({
        ...productionBase,
        ORCHESTRATOR_MODEL_PROVIDER: "fake",
      }),
    ).toThrow(/FAKE PLANNING|fake/i);
  });

  it("rejects unsupported planning provider in PRODUCTION", () => {
    expect(() =>
      loadRuntimeConfig({
        ...productionBase,
        ORCHESTRATOR_MODEL_PROVIDER: "anthropic",
      }),
    ).toThrow(/unsupported|openai/i);
  });

  it("rejects openai without OPENAI_API_KEY in PRODUCTION", () => {
    const env = { ...productionBase };
    delete (env as { OPENAI_API_KEY?: string }).OPENAI_API_KEY;
    expect(() => loadRuntimeConfig(env)).toThrow(/OPENAI_API_KEY/);
  });

  it("does not accept PRODUCTION solely because OPENAI_API_KEY is set", () => {
    const env = { ...productionBase, OPENAI_API_KEY: "sk-present" };
    delete (env as { ORCHESTRATOR_MODEL_PROVIDER?: string })
      .ORCHESTRATOR_MODEL_PROVIDER;
    expect(() => loadRuntimeConfig(env)).toThrow(/ORCHESTRATOR_MODEL_PROVIDER/);
  });

  it("rejects FAKE repository adapter mode in PRODUCTION", () => {
    expect(() =>
      loadRuntimeConfig({
        ...productionBase,
        ORCHESTRATOR_REPOSITORY_ADAPTER_MODE: "FAKE",
      }),
    ).toThrow(/FAKE|REPOSITORY/);
  });

  it("defaults HTTP listen to :: and prefers PORT", () => {
    const config = loadRuntimeConfig({
      ...productionBase,
      PORT: "8080",
    });
    expect(config.httpHost).toBe("::");
    expect(config.httpPort).toBe(8080);
  });

  it("rejects anonymous auth in PRODUCTION", () => {
    expect(() =>
      loadRuntimeConfig({
        ...productionBase,
        ORCHESTRATOR_AUTH_MODE: "ANONYMOUS",
      }),
    ).toThrow(/anonymous/i);
  });

  it("rejects Control Tower unrestricted read flag in PRODUCTION", () => {
    expect(() =>
      loadRuntimeConfig({
        ...productionBase,
        ORCHESTRATOR_CONTROL_TOWER_DEV_ALLOW_ALL: "true",
      }),
    ).toThrow(/CONTROL_TOWER_DEV_ALLOW_ALL|unrestricted/i);
  });

  it("allows Control Tower unrestricted read flag in DEVELOPMENT", () => {
    const config = loadRuntimeConfig({
      ORCHESTRATOR_ENV: "DEVELOPMENT",
      ORCHESTRATOR_STORAGE: "memory",
      ORCHESTRATOR_AUTH_MODE: "ANONYMOUS",
      ORCHESTRATOR_CONTROL_TOWER_DEV_ALLOW_ALL: "true",
    });
    expect(config.controlTowerDevAllowAll).toBe(true);
  });

  it("defaults Control Tower unrestricted read flag to false", () => {
    const config = loadRuntimeConfig({
      ORCHESTRATOR_ENV: "DEVELOPMENT",
      ORCHESTRATOR_STORAGE: "memory",
      ORCHESTRATOR_AUTH_MODE: "ANONYMOUS",
    });
    expect(config.controlTowerDevAllowAll).toBe(false);
  });

  it("rejects missing delivery secret in PRODUCTION", () => {
    const env = { ...productionBase };
    delete env.APPROVAL_DELIVERY_SECRET_KEY;
    expect(() => loadRuntimeConfig(env)).toThrow(/APPROVAL_DELIVERY_SECRET_KEY/);
  });

  it("rejects missing approval delivery provider in PRODUCTION", () => {
    const env = { ...productionBase };
    delete env.ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER;
    expect(() => loadRuntimeConfig(env)).toThrow(
      /ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER/,
    );
  });

  it("rejects Fake approval delivery in PRODUCTION", () => {
    expect(() =>
      loadRuntimeConfig({
        ...productionBase,
        ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER: "fake",
      }),
    ).toThrow(/FAKE DELIVERY|fake is forbidden/i);
  });

  it("rejects unsupported approval delivery provider in PRODUCTION", () => {
    expect(() =>
      loadRuntimeConfig({
        ...productionBase,
        ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER: "sendgrid",
      }),
    ).toThrow(/resend/i);
  });

  it("rejects missing Resend key for approval delivery in PRODUCTION", () => {
    const env = { ...productionBase };
    delete env.RESEND_API_KEY;
    expect(() => loadRuntimeConfig(env)).toThrow(/RESEND_API_KEY/);
  });

  it("rejects missing approval delivery emails in PRODUCTION", () => {
    const missingFrom = { ...productionBase };
    delete missingFrom.APPROVAL_DELIVERY_EMAIL_FROM;
    expect(() => loadRuntimeConfig(missingFrom)).toThrow(
      /APPROVAL_DELIVERY_EMAIL_FROM/,
    );
    const missingTo = { ...productionBase };
    delete missingTo.APPROVAL_DELIVERY_EMAIL_TO;
    expect(() => loadRuntimeConfig(missingTo)).toThrow(
      /APPROVAL_DELIVERY_EMAIL_TO/,
    );
  });

  it("keeps RECOVERY_PROVIDER_MODE=SHADOW independent of approval delivery", () => {
    const config = loadRuntimeConfig(productionBase);
    expect(config.runtimeEnvironment).toBe("PRODUCTION");
    expect(productionBase.RECOVERY_PROVIDER_MODE).toBe("SHADOW");
    expect(productionBase.ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER).toBe(
      "resend",
    );
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
