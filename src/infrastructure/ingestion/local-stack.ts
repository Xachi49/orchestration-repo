import { createLocalAdmissionStack } from "../admission/local-stack.js";
import type { ControlPlaneService } from "../../control-plane/service.js";
import type { ObjectiveAdmissionService } from "../../admission/service.js";
import { RepositoryTruthService } from "../../ingestion/service.js";
import { DeterministicProjectIndexer } from "../../ingestion/indexer.js";
import { DeterministicRepositoryFingerprintService } from "../../ingestion/fingerprint.js";
import {
  EXAMPLE_COMMIT_METADATA,
  EXAMPLE_COMMIT_SHA,
  EXAMPLE_DRIFT_SHA,
  EXAMPLE_REPOSITORY_SOURCE,
  EXAMPLE_WORKSPACE_FILES,
} from "../../ingestion/fixtures.js";
import type { RemoteRepositoryService } from "../../ingestion/remote-repository.js";
import type { RepositoryWorkspaceService } from "../../ingestion/workspace.js";
import type { ProjectIndexer } from "../../ingestion/index-model.js";
import { InMemoryRepositorySourceRegistry } from "./in-memory-source-registry.js";
import { InMemoryLockedRepositoryStore } from "./in-memory-locked-store.js";
import { InMemoryRepositoryIndexStore } from "./in-memory-index-store.js";
import { InMemoryEvidenceRegistry } from "./in-memory-evidence-registry.js";
import { InMemoryVerifiedRepositoryContextStore } from "./in-memory-context-store.js";
import { InMemoryRepositoryIngestionCoordinator } from "./in-memory-ingestion-coordinator.js";
import { FakeRemoteRepository } from "./fake-remote.js";
import { FakeRepositoryWorkspace } from "./fake-workspace.js";
import type { RequesterGrant } from "../../admission/authorization.js";
import type { ResourceBudgetProfile } from "../../control-plane/budgets/budget.js";
import type { Capability } from "../../control-plane/capabilities/capability.js";
import type { InMemoryRunRepository } from "../admission/in-memory-run-repository.js";
import type { InMemoryObjectiveRepository } from "../admission/in-memory-objective-repository.js";
import type { FixedClock } from "../clock.js";
import type { InMemoryCapabilityRegistry } from "../control-plane/in-memory-capability-registry.js";

export interface LocalIngestionStack {
  admission: ObjectiveAdmissionService;
  ingestion: RepositoryTruthService;
  controlPlane: ControlPlaneService;
  /** Same registry instance wired into ControlPlaneService. */
  capabilities: InMemoryCapabilityRegistry;
  runs: InMemoryRunRepository;
  objectives: InMemoryObjectiveRepository;
  remote: FakeRemoteRepository;
  workspace: FakeRepositoryWorkspace;
  locks: InMemoryLockedRepositoryStore;
  evidence: InMemoryEvidenceRegistry;
  contexts: InMemoryVerifiedRepositoryContextStore;
  indexStore: InMemoryRepositoryIndexStore;
  coordinator: InMemoryRepositoryIngestionCoordinator;
  clock: FixedClock;
}

export function createLocalIngestionStack(options?: {
  grants?: readonly RequesterGrant[];
  clockIso?: string;
  budgets?: readonly ResourceBudgetProfile[];
  capabilities?: readonly Capability[];
  remote?: RemoteRepositoryService;
  workspace?: RepositoryWorkspaceService;
  indexer?: ProjectIndexer;
}): LocalIngestionStack {
  const admissionOptions: {
    grants?: readonly RequesterGrant[];
    clockIso?: string;
    budgets?: readonly ResourceBudgetProfile[];
    capabilities?: readonly Capability[];
  } = {};
  if (options?.grants) {
    admissionOptions.grants = options.grants;
  }
  if (options?.clockIso) {
    admissionOptions.clockIso = options.clockIso;
  }
  if (options?.budgets) {
    admissionOptions.budgets = options.budgets;
  }
  if (options?.capabilities) {
    admissionOptions.capabilities = options.capabilities;
  }
  const admissionStack = createLocalAdmissionStack(admissionOptions);
  const remote =
    options?.remote ??
    new FakeRemoteRepository({
      identity: {
        provider: "GITHUB",
        owner: EXAMPLE_REPOSITORY_SOURCE.owner,
        repository: EXAMPLE_REPOSITORY_SOURCE.repository,
      },
      defaultBranch: EXAMPLE_REPOSITORY_SOURCE.defaultBranch,
      branches: {
        [EXAMPLE_REPOSITORY_SOURCE.defaultBranch]: EXAMPLE_COMMIT_SHA,
      },
      commits: {
        [EXAMPLE_COMMIT_SHA]: EXAMPLE_COMMIT_METADATA,
        [EXAMPLE_DRIFT_SHA]: {
          ...EXAMPLE_COMMIT_METADATA,
          sha: EXAMPLE_DRIFT_SHA,
          message: "later commit",
        },
      },
    });
  const filesBySha = new Map([
    [EXAMPLE_COMMIT_SHA, EXAMPLE_WORKSPACE_FILES],
    [EXAMPLE_DRIFT_SHA, EXAMPLE_WORKSPACE_FILES],
  ]);
  const workspace =
    options?.workspace ??
    new FakeRepositoryWorkspace({ filesBySha });
  const locks = new InMemoryLockedRepositoryStore();
  const evidence = new InMemoryEvidenceRegistry();
  const contexts = new InMemoryVerifiedRepositoryContextStore();
  const indexStore = new InMemoryRepositoryIndexStore();
  const coordinator = new InMemoryRepositoryIngestionCoordinator();
  const ingestion = new RepositoryTruthService({
    runs: admissionStack.runs,
    controlPlane: admissionStack.controlPlane,
    sources: new InMemoryRepositorySourceRegistry([EXAMPLE_REPOSITORY_SOURCE]),
    remote,
    locks,
    workspace,
    indexer: options?.indexer ?? new DeterministicProjectIndexer(),
    fingerprints: new DeterministicRepositoryFingerprintService(),
    indexStore,
    evidence,
    contexts,
    coordinator,
    clock: admissionStack.clock,
  });
  return {
    admission: admissionStack.service,
    ingestion,
    controlPlane: admissionStack.controlPlane,
    capabilities: admissionStack.capabilities,
    runs: admissionStack.runs,
    objectives: admissionStack.objectives,
    remote: remote as FakeRemoteRepository,
    workspace: workspace as FakeRepositoryWorkspace,
    locks,
    evidence,
    contexts,
    indexStore,
    coordinator,
    clock: admissionStack.clock,
  };
}
