/**
 * Infrastructure ports — replaceable adapters.
 * LLM, shell execution, and GitHub writes remain disconnected.
 * Phase 3 adds a read-only GitHub adapter and in-memory ingestion stores.
 */

export {
  type ClockPort,
  SystemClock,
  FixedClock,
  type IdGeneratorPort,
  CryptoIdGenerator,
} from "./clock.js";

/** Marker: shell execution is forbidden. */
export interface ShellExecutionPort {
  readonly enabled: false;
}

export const DISABLED_SHELL: ShellExecutionPort = { enabled: false };

/** Marker: LLM providers are not connected. */
export interface LlmPort {
  readonly connected: false;
}

export const DISCONNECTED_LLM: LlmPort = { connected: false };

/**
 * Marker: GitHub writes are not connected.
 * Read-only GitHub access is a separate adapter (`GitHubReadOnlyAdapter`).
 */
export interface GitHubWritePort {
  readonly connected: false;
}

export const DISCONNECTED_GITHUB: GitHubWritePort = { connected: false };

export {
  InMemoryProjectRegistry,
  InMemoryCapabilityRegistry,
  InMemoryPolicyRegistry,
  InMemoryResourceBudgetRegistry,
} from "./control-plane/index.js";

export {
  InMemoryRequesterAuthorization,
  InMemoryIdempotencyStore,
  InMemoryProjectLockService,
  InMemoryRunRepository,
  InMemoryEventStore,
  UuidAdmissionIdentityGenerator,
  SequenceAdmissionIdentityGenerator,
  createLocalAdmissionStack,
} from "./admission/index.js";

export {
  InMemoryRepositorySourceRegistry,
  InMemoryLockedRepositoryStore,
  InMemoryRepositoryIndexStore,
  InMemoryEvidenceRegistry,
  InMemoryVerifiedRepositoryContextStore,
  InMemoryRepositoryIngestionCoordinator,
  FakeRemoteRepository,
  FakeRepositoryWorkspace,
  GitHubReadOnlyAdapter,
  LocalGitWorkspaceService,
  createLocalIngestionStack,
} from "./ingestion/index.js";
