import { describe, expect, it } from "vitest";
import { DeterministicProjectIndexer } from "./indexer.js";
import { DeterministicRepositoryFingerprintService } from "./fingerprint.js";
import {
  EXAMPLE_COMMIT_SHA,
  EXAMPLE_DRIFT_SHA,
  EXAMPLE_REPOSITORY_SOURCE,
  EXAMPLE_WORKSPACE_FILES,
} from "./fixtures.js";
import { InMemoryRepositoryIndexStore } from "../infrastructure/ingestion/in-memory-index-store.js";
import { INDEX_VERSION } from "./index-model.js";
import {
  computeIndexConfigurationFingerprint,
  DEFAULT_INDEX_CONFIGURATION_FINGERPRINT,
  GENERATED_PATH_EXCLUSIONS,
} from "./index-configuration.js";

const EXAMPLE_IDENTITY = {
  provider: "GITHUB" as const,
  owner: EXAMPLE_REPOSITORY_SOURCE.owner,
  repository: EXAMPLE_REPOSITORY_SOURCE.repository,
};

function fingerprintFor(
  files: ReadonlyArray<{ relativePath: string; content: Buffer }>,
  commitSha = EXAMPLE_COMMIT_SHA,
): string {
  const indexer = new DeterministicProjectIndexer();
  const fingerprints = new DeterministicRepositoryFingerprintService();
  const indexed = indexer.index({
    commitSha,
    repositoryIdentity: EXAMPLE_IDENTITY,
    files,
    repositoryFingerprint: "pending",
  });
  return fingerprints.fingerprint({
    commitSha,
    lockfileHashes: indexed.fileManifest.entries
      .filter((entry) => entry.classification === "LOCKFILE")
      .map((entry) => ({ path: entry.relativePath, hash: entry.contentHash })),
    configHashes: indexed.fileManifest.entries
      .filter(
        (entry) =>
          entry.classification === "CONFIG" ||
          entry.classification === "DEPENDENCY_MANIFEST",
      )
      .map((entry) => ({ path: entry.relativePath, hash: entry.contentHash })),
    manifestHash: indexed.fileManifest.manifestHash,
  });
}

describe("repository fingerprint", () => {
  it("is identical for the same repository state", () => {
    expect(fingerprintFor(EXAMPLE_WORKSPACE_FILES)).toBe(
      fingerprintFor(EXAMPLE_WORKSPACE_FILES),
    );
  });

  it("does not change when file order changes", () => {
    const reversed = [...EXAMPLE_WORKSPACE_FILES].reverse();
    expect(fingerprintFor(reversed)).toBe(fingerprintFor(EXAMPLE_WORKSPACE_FILES));
  });

  it("does not include machine-specific absolute paths", () => {
    const withAbs = EXAMPLE_WORKSPACE_FILES.map((file) => ({
      relativePath: file.relativePath,
      content: file.content,
    }));
    const indexed = new DeterministicProjectIndexer().index({
      commitSha: EXAMPLE_COMMIT_SHA,
      repositoryIdentity: EXAMPLE_IDENTITY,
      files: withAbs,
      repositoryFingerprint: "pending",
    });
    expect(
      indexed.fileManifest.entries.every(
        (entry) => !entry.relativePath.startsWith("/"),
      ),
    ).toBe(true);
    expect(fingerprintFor(withAbs)).toBe(fingerprintFor(EXAMPLE_WORKSPACE_FILES));
  });

  it("changes when a relevant file changes", () => {
    const changed = EXAMPLE_WORKSPACE_FILES.map((file) =>
      file.relativePath === "package.json"
        ? { ...file, content: Buffer.from('{"name":"changed"}\n', "utf8") }
        : file,
    );
    expect(fingerprintFor(changed)).not.toBe(
      fingerprintFor(EXAMPLE_WORKSPACE_FILES),
    );
  });

  it("changes when the commit SHA changes", () => {
    expect(fingerprintFor(EXAMPLE_WORKSPACE_FILES, EXAMPLE_DRIFT_SHA)).not.toBe(
      fingerprintFor(EXAMPLE_WORKSPACE_FILES, EXAMPLE_COMMIT_SHA),
    );
  });
});

describe("deterministic project index cache identity", () => {
  const indexer = new DeterministicProjectIndexer();

  it("orders manifest entries deterministically and classifies files", () => {
    const reversed = [...EXAMPLE_WORKSPACE_FILES].reverse();
    const index = indexer.index({
      commitSha: EXAMPLE_COMMIT_SHA,
      repositoryIdentity: EXAMPLE_IDENTITY,
      files: reversed,
      repositoryFingerprint: "fp",
    });
    const paths = index.fileManifest.entries.map((entry) => entry.relativePath);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
    expect(index.lockfiles).toContain("package-lock.json");
    expect(index.dependencyManifests).toContain("package.json");
    expect(index.testFiles).toContain("src/index.test.ts");
    expect(index.documentationFiles).toContain("README.md");
    expect(index.sourceEntryPoints).toContain("src/index.ts");
    expect(
      index.fileManifest.entries.some(
        (entry) => entry.relativePath === "assets/blob.bin" && entry.binary,
      ),
    ).toBe(true);
    expect(index.generatedExclusions).toContain("dist/out.js");
    expect(
      index.fileManifest.entries.some(
        (entry) => entry.relativePath === "dist/out.js",
      ),
    ).toBe(false);
  });

  it("reuses cache for same repository + SHA + version + configuration", async () => {
    const store = new InMemoryRepositoryIndexStore();
    const first = indexer.index({
      commitSha: EXAMPLE_COMMIT_SHA,
      repositoryIdentity: EXAMPLE_IDENTITY,
      files: EXAMPLE_WORKSPACE_FILES,
      repositoryFingerprint: "fp",
    });
    await store.save(first);
    const key = {
      repositoryIdentity: EXAMPLE_IDENTITY,
      commitSha: EXAMPLE_COMMIT_SHA,
      indexVersion: INDEX_VERSION,
      indexConfigurationFingerprint: DEFAULT_INDEX_CONFIGURATION_FINGERPRINT,
    };
    expect(await store.exists(key)).toBe(true);
    const cached = await store.get(key);
    expect(cached?.fileManifest.manifestHash).toBe(
      first.fileManifest.manifestHash,
    );
  });

  it("does not reuse cache for a different repository identity", async () => {
    const store = new InMemoryRepositoryIndexStore();
    const first = indexer.index({
      commitSha: EXAMPLE_COMMIT_SHA,
      repositoryIdentity: EXAMPLE_IDENTITY,
      files: EXAMPLE_WORKSPACE_FILES,
      repositoryFingerprint: "fp",
    });
    await store.save(first);
    expect(
      await store.get({
        repositoryIdentity: {
          provider: "GITHUB",
          owner: "other",
          repository: "repo",
        },
        commitSha: EXAMPLE_COMMIT_SHA,
        indexVersion: INDEX_VERSION,
        indexConfigurationFingerprint: DEFAULT_INDEX_CONFIGURATION_FINGERPRINT,
      }),
    ).toBeNull();
  });

  it("does not reuse cache when index configuration changes", async () => {
    const store = new InMemoryRepositoryIndexStore();
    const first = indexer.index({
      commitSha: EXAMPLE_COMMIT_SHA,
      repositoryIdentity: EXAMPLE_IDENTITY,
      files: EXAMPLE_WORKSPACE_FILES,
      repositoryFingerprint: "fp",
    });
    await store.save(first);
    const changedConfig = computeIndexConfigurationFingerprint({
      generatedPathExclusions: ["dist/", "build/", "node_modules/", ".git/"],
    });
    expect(changedConfig).not.toBe(DEFAULT_INDEX_CONFIGURATION_FINGERPRINT);
    expect(
      await store.get({
        repositoryIdentity: EXAMPLE_IDENTITY,
        commitSha: EXAMPLE_COMMIT_SHA,
        indexVersion: INDEX_VERSION,
        indexConfigurationFingerprint: changedConfig,
      }),
    ).toBeNull();
  });

  it("does not alter configuration fingerprint when exclusion order differs", () => {
    expect(computeIndexConfigurationFingerprint()).toBe(
      DEFAULT_INDEX_CONFIGURATION_FINGERPRINT,
    );
    expect(
      computeIndexConfigurationFingerprint({
        generatedPathExclusions: [...GENERATED_PATH_EXCLUSIONS].reverse(),
      }),
    ).toBe(DEFAULT_INDEX_CONFIGURATION_FINGERPRINT);
  });
});
