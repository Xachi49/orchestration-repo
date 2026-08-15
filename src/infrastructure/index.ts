/**
 * Infrastructure ports — replaceable adapters.
 * Shell execution and GitHub writes remain disconnected.
 * Phase 4 adds an optional OpenAI planning adapter (opt-in; default stack is fake).
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

/**
 * Marker: generic LLM providers are not connected by default.
 * Optional OpenAIPlanningModel is separate and opt-in.
 */
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
  InMemoryObjectiveRepository,
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

export {
  OpenAIPlanningModel,
  createLocalPlanningStack,
} from "./planning/index.js";
