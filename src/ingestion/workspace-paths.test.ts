import { describe, expect, it } from "vitest";
import { resolveContained } from "./workspace-paths.js";
import { IngestionError } from "./errors.js";

describe("resolveContained", () => {
  const root = "/app-data/runs/run_1/workspace";

  it("resolves a relative file inside the workspace", () => {
    expect(resolveContained(root, "src/index.ts")).toBe(
      `${root}/src/index.ts`,
    );
  });

  it("rejects path traversal", () => {
    expect(() => resolveContained(root, "../secret")).toThrow(IngestionError);
    expect(() => resolveContained(root, "/etc/passwd")).toThrow(IngestionError);
    expect(() => resolveContained(root, "foo/../../etc/passwd")).toThrow(
      IngestionError,
    );
  });
});
