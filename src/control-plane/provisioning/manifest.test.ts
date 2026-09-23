import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computePolicyBundleHash,
  materializeControlPlaneManifest,
  parseControlPlaneProvisionManifest,
} from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PILOT_MANIFEST_PATH = join(
  HERE,
  "../../../manifests/control-plane/continuum-revenue-recovery-pilot.json",
);

describe("control-plane provisioning manifest", () => {
  it("parses the continuum RR pilot manifest and hashes the policy canonically", () => {
    const raw = JSON.parse(readFileSync(PILOT_MANIFEST_PATH, "utf8"));
    const manifest = parseControlPlaneProvisionManifest(raw);
    expect(manifest.project.projectId).toBe(
      "continuum-revenue-recovery-pilot",
    );
    expect(manifest.project.executionMode).toBe("SUPERVISED");
    // Phase 3 ingest synthesizes GITHUB identity from Project.repositoryUrl when
    // RepositorySourceRegistry has no row — registry entry is optional.
    expect(manifest.repositorySource).toBeUndefined();
    expect(manifest.project.repositoryUrl).toBe(
      "https://github.com/Xachi49/orchestration-repo.git",
    );

    const materialized = materializeControlPlaneManifest(
      manifest,
      "2026-09-22T12:00:00.000Z",
    );
    expect(materialized.policyBundle.policyHash.startsWith("sha256:")).toBe(
      true,
    );
    expect(materialized.policyBundle.policyHash).not.toContain(
      "continuum-rr-pilot-v1",
    );
    expect(materialized.policyBundle.policyHash).toBe(
      computePolicyBundleHash({
        policyBundleId: materialized.policyBundle.policyBundleId,
        semanticVersion: materialized.policyBundle.semanticVersion,
        supersedes: materialized.policyBundle.supersedes,
        applicableProjectIds: materialized.policyBundle.applicableProjectIds,
        applicableEnvironments:
          materialized.policyBundle.applicableEnvironments,
        approvedBy: materialized.policyBundle.approvedBy,
        status: materialized.policyBundle.status,
        rules: materialized.policyBundle.rules,
      }),
    );
  });

  it("rejects unknown keys and placeholder-free malformed input before mutation", () => {
    expect(() =>
      parseControlPlaneProvisionManifest({
        project: { projectId: "x" },
        unexpected: true,
      }),
    ).toThrow();
  });

  it("documents production bootstrap remains seed-free", () => {
    const bootstrap = readFileSync(
      join(HERE, "../../infrastructure/bootstrap.ts"),
      "utf8",
    );
    expect(bootstrap).toContain("seedControlPlane: false");
    expect(bootstrap).toContain("seedRepositorySources: false");
  });
});
