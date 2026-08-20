import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

describe("Phase 12 architecture constraints", () => {
  it("domain does not import runtime", () => {
    const files = collectTs("src/domain");
    for (const file of files) {
      const body = readFileSync(file, "utf8");
      expect(body).not.toMatch(/from ["'].*runtime/);
    }
  });

  it("documents production authority non-equivalence", () => {
    const body = readFileSync("docs/phase-12-production-readiness.md", "utf8");
    expect(body).toContain("Runtime configuration does not create policy authority");
    expect(body).toContain("Authentication does not create approval authority");
    expect(body).toContain("Worker ownership does not create execution authorization");
    expect(body).toContain("Readiness does not create business truth");
    expect(body).toContain("Metrics do not create policy");
    expect(body).toContain("Deployment version does not create authority");
  });
});

function collectTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...collectTs(path));
    } else if (entry.name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}
