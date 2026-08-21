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

describe("Phase 13 scheduling constraints", () => {
  it("scheduling module does not import model providers", () => {
    const files = collectTs("src/scheduling");
    for (const file of files) {
      if (file.endsWith(".test.ts")) {
        continue;
      }
      const body = readFileSync(file, "utf8");
      expect(body).not.toMatch(/from ["'].*openai/);
      expect(body).not.toMatch(/from ["'].*anthropic/);
      expect(body).not.toMatch(/PlanningModel/);
      expect(body).not.toMatch(/InferencePort/);
    }
  });

  it("documents scheduling authority boundary", () => {
    const body = readFileSync(
      "docs/scheduling-authority-boundary.md",
      "utf8",
    );
    expect(body).toContain("ELIGIBLE");
    expect(body).toContain("AUTHORIZED");
    expect(body).toContain("AUTONOMOUS APPROVAL");
    expect(body).toContain("Forbidden");
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
