import { hashCanonical } from "./hashing.js";

/**
 * Classification / exclusion rules version. Bump when deterministic indexing
 * behavior changes in a way that invalidates cached indexes.
 */
export const INDEX_CLASSIFICATION_RULES_VERSION = "1.0.0";

export const GENERATED_PATH_EXCLUSIONS = [
  ".git/",
  "coverage/",
  "dist/",
  "node_modules/",
] as const;

export const LOCKFILE_NAMES = [
  "Cargo.lock",
  "go.sum",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;

export const DEPENDENCY_MANIFEST_NAMES = [
  "Cargo.toml",
  "go.mod",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
] as const;

export const CONFIG_FILE_NAMES = [
  ".gitignore",
  "eslint.config.js",
  "tsconfig.json",
  "vitest.config.ts",
] as const;

export const SOURCE_LANGUAGE_EXTENSIONS = [
  ".go",
  ".js",
  ".mjs",
  ".py",
  ".rs",
  ".ts",
] as const;

export interface IndexConfigurationInput {
  classificationRulesVersion?: string;
  generatedPathExclusions?: readonly string[];
  lockfileNames?: readonly string[];
  dependencyManifestNames?: readonly string[];
  configFileNames?: readonly string[];
  sourceLanguageExtensions?: readonly string[];
}

/**
 * Deterministic fingerprint of indexing behavior relevant to cache validity.
 * Excludes machine-specific paths and timestamps.
 */
export function computeIndexConfigurationFingerprint(
  input: IndexConfigurationInput = {},
): string {
  return hashCanonical({
    classificationRulesVersion:
      input.classificationRulesVersion ?? INDEX_CLASSIFICATION_RULES_VERSION,
    generatedPathExclusions: [
      ...(input.generatedPathExclusions ?? GENERATED_PATH_EXCLUSIONS),
    ].sort((a, b) => a.localeCompare(b)),
    lockfileNames: [...(input.lockfileNames ?? LOCKFILE_NAMES)].sort((a, b) =>
      a.localeCompare(b),
    ),
    dependencyManifestNames: [
      ...(input.dependencyManifestNames ?? DEPENDENCY_MANIFEST_NAMES),
    ].sort((a, b) => a.localeCompare(b)),
    configFileNames: [...(input.configFileNames ?? CONFIG_FILE_NAMES)].sort(
      (a, b) => a.localeCompare(b),
    ),
    sourceLanguageExtensions: [
      ...(input.sourceLanguageExtensions ?? SOURCE_LANGUAGE_EXTENSIONS),
    ].sort((a, b) => a.localeCompare(b)),
  });
}

export const DEFAULT_INDEX_CONFIGURATION_FINGERPRINT =
  computeIndexConfigurationFingerprint();
