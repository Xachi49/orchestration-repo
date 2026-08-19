import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("durability architecture documentation", () => {
  it("documents that exactly-once external side effects are not assumed", () => {
    const body = readFileSync("docs/durability.md", "utf8");
    expect(body).toContain("EXACTLY-ONCE EXTERNAL SIDE EFFECTS ARE NOT ASSUMED");
    expect(body).toContain("APPLICATION CLOCK != DISTRIBUTED LEASE CLOCK");
    expect(body).toContain("LOCAL FILE PATH != DISTRIBUTED ARTIFACT AUTHORITY");
  });

  it("keeps pg isolated under infrastructure/postgres", () => {
    const body = readFileSync(
      "src/infrastructure/postgres/database.ts",
      "utf8",
    );
    expect(body).toContain('from "pg"');
  });

  it("postgres production stack does not silently fall back to memory", () => {
    const stack = readFileSync("src/infrastructure/postgres/stack.ts", "utf8");
    expect(stack).not.toMatch(/ORCHESTRATOR_STORAGE.*memory/);
    expect(stack).not.toMatch(/fallback.*InMemory/);
    const config = readFileSync("src/infrastructure/postgres/config.ts", "utf8");
    expect(config).toContain("STORAGE_MODE_INVALID");
  });
});
