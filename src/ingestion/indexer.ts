import type {
  FileClassification,
  FileManifest,
  FileManifestEntry,
  ProjectIndex,
  ProjectIndexer,
} from "./index-model.js";
import { INDEX_VERSION } from "./index-model.js";
import {
  CONFIG_FILE_NAMES,
  DEFAULT_INDEX_CONFIGURATION_FINGERPRINT,
  DEPENDENCY_MANIFEST_NAMES,
  GENERATED_PATH_EXCLUSIONS,
  LOCKFILE_NAMES,
  SOURCE_LANGUAGE_EXTENSIONS,
} from "./index-configuration.js";
import { hashCanonical, posixRelative, sha256Buffer } from "./hashing.js";
import type { CommitSha } from "./remote-repository.js";
import type { RepositoryIdentity } from "./repository-source.js";

const SKIP_DIR_PREFIXES: readonly string[] = [...GENERATED_PATH_EXCLUSIONS];
const LOCKFILES = new Set<string>(LOCKFILE_NAMES);
const MANIFESTS = new Set<string>(DEPENDENCY_MANIFEST_NAMES);
const CONFIG_NAMES = new Set<string>(CONFIG_FILE_NAMES);
const SOURCE_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".js": "javascript",
  ".mjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
};

function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }
  return base.slice(dot).toLowerCase();
}

function isBinary(content: Buffer, extension: string): boolean {
  const binaryExt = new Set([".png", ".jpg", ".jpeg", ".gif", ".woff", ".zip"]);
  if (binaryExt.has(extension)) {
    return true;
  }
  const sample = content.subarray(0, 8000);
  return sample.includes(0);
}

function isGeneratedPath(path: string): boolean {
  return SKIP_DIR_PREFIXES.some(
    (prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix),
  );
}

function classify(
  path: string,
  binary: boolean,
  generated: boolean,
): FileClassification {
  if (generated) {
    return "GENERATED";
  }
  if (binary) {
    return "BINARY";
  }
  const base = path.split("/").pop() ?? path;
  if (LOCKFILES.has(base)) {
    return "LOCKFILE";
  }
  if (MANIFESTS.has(base)) {
    return "DEPENDENCY_MANIFEST";
  }
  if (CONFIG_NAMES.has(base) || path.endsWith(".config.ts")) {
    return "CONFIG";
  }
  if (
    path.includes("/test/") ||
    path.includes("/tests/") ||
    /\.(test|spec)\.[a-z]+$/i.test(path)
  ) {
    return "TEST";
  }
  if (path.endsWith(".md") || path.startsWith("docs/")) {
    return "DOCUMENTATION";
  }
  if (path.endsWith(".d.ts") || path.includes("/api/")) {
    return "SOURCE";
  }
  if (SOURCE_LANGUAGE_EXTENSIONS.includes(extensionOf(path) as (typeof SOURCE_LANGUAGE_EXTENSIONS)[number])) {
    return "SOURCE";
  }
  if (SOURCE_LANG[extensionOf(path)]) {
    return "SOURCE";
  }
  return "OTHER";
}

export class DeterministicProjectIndexer implements ProjectIndexer {
  index(input: {
    commitSha: CommitSha;
    repositoryIdentity: RepositoryIdentity;
    files: ReadonlyArray<{ relativePath: string; content: Buffer }>;
    repositoryFingerprint: string;
    indexConfigurationFingerprint?: string;
  }): ProjectIndex {
    const entries: FileManifestEntry[] = [];
    const generatedExclusions: string[] = [];

    for (const file of input.files) {
      const relativePath = posixRelative(file.relativePath);
      if (relativePath === "" || relativePath.includes("..")) {
        continue;
      }
      const generated = isGeneratedPath(relativePath);
      if (generated) {
        generatedExclusions.push(relativePath);
        continue;
      }
      const extension = extensionOf(relativePath);
      const binary = isBinary(file.content, extension);
      const classification = classify(relativePath, binary, generated);
      const language = SOURCE_LANG[extension];
      const entry: FileManifestEntry = {
        relativePath,
        contentHash: sha256Buffer(file.content),
        size: file.content.byteLength,
        classification,
        extension,
        generated,
        binary,
        trustClassification: "LOCAL_VERIFIED",
      };
      if (language !== undefined) {
        entry.language = language;
      }
      entries.push(entry);
    }

    entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    generatedExclusions.sort((a, b) => a.localeCompare(b));

    const manifest: FileManifest = {
      commitSha: input.commitSha,
      entries,
      manifestHash: hashCanonical(
        entries.map((entry) => ({
          relativePath: entry.relativePath,
          contentHash: entry.contentHash,
          size: entry.size,
          classification: entry.classification,
        })),
      ),
    };

    const paths = (classification: FileClassification) =>
      entries
        .filter((entry) => entry.classification === classification)
        .map((entry) => entry.relativePath);

    const sourceEntryPoints = entries
      .filter(
        (entry) =>
          entry.relativePath === "src/index.ts" ||
          entry.relativePath === "src/main.ts" ||
          entry.relativePath === "index.ts",
      )
      .map((entry) => entry.relativePath);

    const interfaceDefinitions = entries
      .filter(
        (entry) =>
          entry.relativePath.endsWith(".d.ts") ||
          entry.relativePath.startsWith("src/api/"),
      )
      .map((entry) => entry.relativePath);

    return {
      indexVersion: INDEX_VERSION,
      repositoryIdentity: input.repositoryIdentity,
      commitSha: input.commitSha,
      indexConfigurationFingerprint:
        input.indexConfigurationFingerprint ??
        DEFAULT_INDEX_CONFIGURATION_FINGERPRINT,
      repositoryFingerprint: input.repositoryFingerprint,
      fileManifest: manifest,
      sourceEntryPoints,
      dependencyManifests: paths("DEPENDENCY_MANIFEST"),
      lockfiles: paths("LOCKFILE"),
      configurationFiles: paths("CONFIG"),
      testFiles: paths("TEST"),
      documentationFiles: paths("DOCUMENTATION"),
      interfaceDefinitions,
      generatedExclusions,
    };
  }
}
