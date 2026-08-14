/**
 * Infrastructure ports — replaceable adapters.
 * No GitHub, LLM, shell, or secret-bearing implementations.
 * Phase 2 ships in-memory control-plane and admission adapters.
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

/** Marker: GitHub APIs are not connected. */
export interface GitHubPort {
  readonly connected: false;
}

export const DISCONNECTED_GITHUB: GitHubPort = { connected: false };

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
