import { z } from "zod";
import { TrustLevelSchema } from "../domain/evidence/evidence.js";
import { CommitShaSchema, type CommitSha } from "./remote-repository.js";
import { RepositoryIdentitySchema, type RepositoryIdentity } from "./repository-source.js";
import { DEFAULT_INDEX_CONFIGURATION_FINGERPRINT } from "./index-configuration.js";

export const INDEX_VERSION = "1.0.0";
export const CONTEXT_SCHEMA_VERSION = "1.0.0";

export const FileClassificationSchema = z.enum([
  "SOURCE",
  "TEST",
  "DOCUMENTATION",
  "CONFIG",
  "DEPENDENCY_MANIFEST",
  "LOCKFILE",
  "GENERATED",
  "BINARY",
  "OTHER",
]);
export type FileClassification = z.infer<typeof FileClassificationSchema>;

export const FileManifestEntrySchema = z
  .object({
    relativePath: z.string().min(1),
    contentHash: z.string().min(1),
    size: z.number().int().nonnegative(),
    classification: FileClassificationSchema,
    extension: z.string(),
    language: z.string().optional(),
    generated: z.boolean(),
    binary: z.boolean(),
    trustClassification: TrustLevelSchema,
  })
  .strict();
export type FileManifestEntry = z.infer<typeof FileManifestEntrySchema>;

export const FileManifestSchema = z
  .object({
    commitSha: CommitShaSchema,
    entries: z.array(FileManifestEntrySchema),
    manifestHash: z.string().min(1),
  })
  .strict();
export type FileManifest = z.infer<typeof FileManifestSchema>;

export const ProjectIndexSchema = z
  .object({
    indexVersion: z.literal(INDEX_VERSION),
    repositoryIdentity: RepositoryIdentitySchema,
    commitSha: CommitShaSchema,
    indexConfigurationFingerprint: z.string().min(1),
    repositoryFingerprint: z.string().min(1),
    fileManifest: FileManifestSchema,
    sourceEntryPoints: z.array(z.string()),
    dependencyManifests: z.array(z.string()),
    lockfiles: z.array(z.string()),
    configurationFiles: z.array(z.string()),
    testFiles: z.array(z.string()),
    documentationFiles: z.array(z.string()),
    interfaceDefinitions: z.array(z.string()),
    generatedExclusions: z.array(z.string()),
  })
  .strict();
export type ProjectIndex = z.infer<typeof ProjectIndexSchema>;

export interface RepositoryIndexCacheKey {
  repositoryIdentity: RepositoryIdentity;
  commitSha: string;
  indexVersion: string;
  indexConfigurationFingerprint: string;
}

export function repositoryIndexCacheKeyString(
  key: RepositoryIndexCacheKey,
): string {
  const identity = key.repositoryIdentity;
  return [
    identity.provider,
    identity.owner.toLowerCase(),
    identity.repository.toLowerCase(),
    key.commitSha.toLowerCase(),
    key.indexVersion,
    key.indexConfigurationFingerprint,
  ].join("::");
}

export interface ProjectIndexer {
  index(input: {
    commitSha: CommitSha;
    repositoryIdentity: RepositoryIdentity;
    files: ReadonlyArray<{ relativePath: string; content: Buffer }>;
    repositoryFingerprint: string;
    indexConfigurationFingerprint?: string;
  }): ProjectIndex;
}

export interface RepositoryIndexStore {
  get(key: RepositoryIndexCacheKey): Promise<ProjectIndex | null>;
  save(index: ProjectIndex): Promise<ProjectIndex>;
  exists(key: RepositoryIndexCacheKey): Promise<boolean>;
}

export interface RepositoryFingerprintInput {
  commitSha: string;
  lockfileHashes: ReadonlyArray<{ path: string; hash: string }>;
  configHashes: ReadonlyArray<{ path: string; hash: string }>;
  manifestHash: string;
}

export interface RepositoryFingerprintService {
  fingerprint(input: RepositoryFingerprintInput): string;
}

export { DEFAULT_INDEX_CONFIGURATION_FINGERPRINT };
