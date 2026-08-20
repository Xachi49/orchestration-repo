import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("Phase 12 container and CI acceptance", () => {
  it("Dockerfile is multi-stage, non-root, and uses node as PID 1", () => {
    const body = readFileSync("Dockerfile", "utf8");
    expect(body).toMatch(/FROM node:22-alpine AS build/);
    expect(body).toMatch(/FROM node:22-alpine/);
    expect(body).toMatch(/USER 10001/);
    expect(body).toMatch(/ENTRYPOINT \["node","dist\/runtime\/main\.js"\]/);
    expect(body).not.toMatch(/APPROVAL_DELIVERY_SECRET_KEY=/);
    expect(body).not.toMatch(/DATABASE_URL=/);
    expect(body).toMatch(/npm prune --omit=dev/);
  });

  it("CI runs typecheck, unit, build, real PostgreSQL, and audit", () => {
    const body = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(body).toContain("postgres:16-alpine");
    expect(body).toContain("npm run typecheck");
    expect(body).toContain("npm test");
    expect(body).toContain("npm run build");
    expect(body).toContain("npm run test:postgres");
    expect(body).toContain("npm audit --omit=dev --audit-level=high");
    expect(body).toContain("TEST_DATABASE_URL");
    expect(body).not.toContain("deploy");
  });
});
