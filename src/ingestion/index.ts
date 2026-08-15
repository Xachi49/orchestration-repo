/**
 * Ingestion boundary — verified repository truth.
 * External repository content is evidence, not authority or instructions.
 */
export { INGESTION_BOUNDARY, type IngestionPort } from "./port.js";

export {
  INGESTION_ERROR_CODES,
  IngestionError,
  isIngestionError,
  type IngestionErrorCode,
} from "./errors.js";

export {
  RepositoryProviderSchema,
  RepositoryIdentitySchema,
  RepositorySourceSchema,
  parseRepositorySource,
  parseGitHubRemoteUrl,
  type RepositoryProvider,
  type RepositoryIdentity,
  type RepositorySource,
  type RepositorySourceRegistry,
} from "./repository-source.js";

export {
  COMMIT_SHA_PATTERN,
  CommitShaSchema,
  RepositoryMetadataSchema,
  CommitMetadataSchema,
  PullRequestMetadataSchema,
  IssueMetadataSchema,
  CiStatusSchema,
  RemoteRepositorySnapshotSchema,
  SNAPSHOT_VERSION,
  type CommitSha,
  type RepositoryMetadata,
  type CommitMetadata,
  type PullRequestMetadata,
  type IssueMetadata,
  type CiStatus,
  type RemoteRepositorySnapshot,
  type RemoteRepositoryRef,
  type RemoteRepositoryService,
} from "./remote-repository.js";

export {
  LockedRepositoryStatusSchema,
  LockedRepositoryStateSchema,
  type LockedRepositoryStatus,
  type LockedRepositoryState,
  type LockedRepositoryStore,
} from "./locked-state.js";

export type {
  PreparedWorkspace,
  HeadVerification,
  RepositoryWorkspaceService,
} from "./workspace.js";

export {
  INDEX_VERSION,
  CONTEXT_SCHEMA_VERSION,
  FileClassificationSchema,
  FileManifestEntrySchema,
  FileManifestSchema,
  ProjectIndexSchema,
  repositoryIndexCacheKeyString,
  DEFAULT_INDEX_CONFIGURATION_FINGERPRINT,
  type FileClassification,
  type FileManifestEntry,
  type FileManifest,
  type ProjectIndex,
  type ProjectIndexer,
  type RepositoryIndexStore,
  type RepositoryIndexCacheKey,
  type RepositoryFingerprintInput,
  type RepositoryFingerprintService,
} from "./index-model.js";

export {
  INDEX_CLASSIFICATION_RULES_VERSION,
  computeIndexConfigurationFingerprint,
} from "./index-configuration.js";

export { DeterministicProjectIndexer } from "./indexer.js";
export { DeterministicRepositoryFingerprintService } from "./fingerprint.js";

export {
  DRIFT_RESULTS,
  compareLockedToRemote,
  type DriftResultCode,
  type DriftResult,
} from "./drift.js";

export {
  VerifiedRepositoryContextSchema,
  VerifiedRepositoryContextStatusSchema,
  isVerifiedReadyForPlanning,
  type VerifiedRepositoryContext,
  type VerifiedRepositoryContextStatus,
  type VerifiedRepositoryContextStore,
  type EvidenceRegistry,
} from "./context.js";

export {
  IngestionFenceStatusSchema,
  IngestionFenceSchema,
  type IngestionFenceStatus,
  type IngestionFence,
  type BeginIngestionResult,
  type RepositoryIngestionCoordinator,
} from "./coordinator.js";

export { RepositoryTruthService, type RepositoryTruthServiceDeps } from "./service.js";
export { evidenceIdFor } from "./evidence-ids.js";
