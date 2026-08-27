import { expect } from "vitest";
import { ControlPlaneService } from "../control-plane/service.js";
import {
  EXAMPLE_BUDGET,
  EXAMPLE_CAPABILITIES,
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_POLICY_BUNDLE,
  EXAMPLE_PROJECT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { InMemoryProjectRegistry } from "../infrastructure/control-plane/in-memory-project-registry.js";
import { InMemoryCapabilityRegistry } from "../infrastructure/control-plane/in-memory-capability-registry.js";
import { InMemoryPolicyRegistry } from "../infrastructure/control-plane/in-memory-policy-registry.js";
import { InMemoryResourceBudgetRegistry } from "../infrastructure/control-plane/in-memory-budget-registry.js";
import { FixedClock } from "../infrastructure/index.js";
import { createLocalAdmissionStack } from "../infrastructure/admission/local-stack.js";
import { SequenceDecisionNonceGenerator } from "../authorization/decision-nonce.js";
import {
  InMemorySchedulerProjectConfigRepository,
  InMemorySchedulerWorkItemRepository,
} from "../scheduling/index.js";
import {
  ExperimentOrchestrationService,
  ExperimentProgressionLoop,
  ExperimentWorkMaterializer,
  FakeExperimentDesignModel,
  FakeExperimentObjectiveAdmissionPort,
  FakeExperimentOutcomeVerificationPort,
  Phase2ExperimentObjectiveAdmissionPort,
  InMemoryExperimentRepository,
  InMemoryExperimentPlanRepository,
  InMemoryExperimentAuthorizationRequestRepository,
  InMemoryExperimentAuthorizationRecordRepository,
  InMemoryExperimentResultRepository,
  InMemoryExperimentEvidenceBundleRepository,
  InMemoryAssumptionEvidenceUpdateCandidateRepository,
  InMemoryExperimentCompletionRecordRepository,
  InMemoryExperimentExecutionLineageRepository,
  InMemoryExperimentUsageLedgerRepository,
} from "./index.js";

const clock = new FixedClock("2026-08-14T12:00:00.000Z");
export const EXPERIMENT_TEST_NOW = "2026-01-01T00:00:00.000Z";

export function buildExperimentSponsorChecker(
  grants: ReadonlyMap<string, ReadonlySet<string>>,
): (principalId: string, projectIds: readonly string[]) => Promise<boolean> {
  return async (principalId, projectIds) => {
    const held = grants.get(principalId);
    if (!held) return false;
    const unique = [...new Set(projectIds.filter((id) => id.length > 0))];
    if (unique.length === 0) return false;
    return unique.every((projectId) => held.has(projectId));
  };
}

const DEFAULT_SPONSOR_GRANTS = new Map<string, ReadonlySet<string>>([
  ["sponsor_full", new Set([EXAMPLE_PROJECT_ID])],
  ["approver_only", new Set()],
]);

const DEFAULT_BUDGET = {
  maximumActions: 10,
  maximumDurationHours: 24,
  maximumModelCalls: 5,
  maximumTotalTokens: 10_000,
  maximumSampleSize: 100,
  maximumEstimatedCost: 50,
  maximumExternalSideEffects: 0,
} as const;

export function buildExperimentService(opts?: {
  sponsorGrants?: ReadonlyMap<string, ReadonlySet<string>>;
  projects?: typeof EXAMPLE_PROJECT[];
  objectiveAdmissionPort?: FakeExperimentObjectiveAdmissionPort | null;
  outcomeVerificationPort?: FakeExperimentOutcomeVerificationPort | null;
  useRealPhase2?: boolean;
  compileFailpoint?: {
    afterAdmit?(): Promise<void>;
    afterLineage?(): Promise<void>;
  };
  budgetEnvelopeOverride?: Partial<typeof DEFAULT_BUDGET>;
}) {
  const experiments = new InMemoryExperimentRepository();
  const plans = new InMemoryExperimentPlanRepository();
  const authRequests = new InMemoryExperimentAuthorizationRequestRepository();
  const authRecords = new InMemoryExperimentAuthorizationRecordRepository();
  const results = new InMemoryExperimentResultRepository();
  const evidenceBundles = new InMemoryExperimentEvidenceBundleRepository();
  const updateCandidates =
    new InMemoryAssumptionEvidenceUpdateCandidateRepository();
  const completions = new InMemoryExperimentCompletionRecordRepository();
  const lineage = new InMemoryExperimentExecutionLineageRepository();
  const usageLedger = new InMemoryExperimentUsageLedgerRepository();
  const workItems = new InMemorySchedulerWorkItemRepository();
  const nonceStore = new Map<string, string>();

  const controlPlaneProjects = opts?.projects ?? [EXAMPLE_PROJECT];
  const projects = new InMemoryProjectRegistry(controlPlaneProjects);
  const controlPlane = new ControlPlaneService({
    projects,
    capabilities: new InMemoryCapabilityRegistry(EXAMPLE_CAPABILITIES),
    policies: new InMemoryPolicyRegistry([EXAMPLE_POLICY_BUNDLE], { clock }),
    budgets: new InMemoryResourceBudgetRegistry([EXAMPLE_BUDGET]),
    clock,
  });

  const admissionStack = opts?.useRealPhase2
    ? createLocalAdmissionStack({ clockIso: clock.nowIso() })
    : null;

  const objectiveAdmissionPort =
    opts?.objectiveAdmissionPort === null
      ? undefined
      : opts?.useRealPhase2 && admissionStack
        ? new Phase2ExperimentObjectiveAdmissionPort(admissionStack.service)
        : (opts?.objectiveAdmissionPort ??
          new FakeExperimentObjectiveAdmissionPort());

  const outcomeVerificationPort =
    opts?.outcomeVerificationPort === null
      ? undefined
      : (opts?.outcomeVerificationPort ??
        new FakeExperimentOutcomeVerificationPort());

  const service = new ExperimentOrchestrationService({
    nowIso: () => EXPERIMENT_TEST_NOW,
    experiments,
    plans,
    authRequests,
    authRecords,
    results,
    evidenceBundles,
    updateCandidates,
    completions,
    lineage,
    usageLedger,
    controlPlane,
    designModel: new FakeExperimentDesignModel(),
    nonceGenerator: new SequenceDecisionNonceGenerator(),
    authNonceStore: {
      put: async (id, plaintext) => {
        nonceStore.set(id, plaintext);
      },
      take: async (id) => nonceStore.get(id) ?? null,
    },
    isExperimentSponsor: buildExperimentSponsorChecker(
      opts?.sponsorGrants ?? DEFAULT_SPONSOR_GRANTS,
    ),
    ...(objectiveAdmissionPort !== undefined
      ? { objectiveAdmissionPort }
      : {}),
    ...(outcomeVerificationPort !== undefined
      ? { outcomeVerificationPort }
      : {}),
    ...(admissionStack
      ? {
          resolveRunProjectId: async (runId: string) => {
            const run = await admissionStack.runs.getById(runId);
            return run?.projectId ?? null;
          },
        }
      : {}),
    ...(opts?.compileFailpoint
      ? { compileFailpoint: opts.compileFailpoint }
      : {}),
  });

  const materializer = new ExperimentWorkMaterializer({
    nowIso: () => EXPERIMENT_TEST_NOW,
    experiments,
    plans,
    workItems,
    projectConfigs: new InMemorySchedulerProjectConfigRepository(),
  });

  const progression = new ExperimentProgressionLoop({
    experiments,
    materializer,
  });

  return {
    service,
    experiments,
    plans,
    authRequests,
    authRecords,
    results,
    evidenceBundles,
    updateCandidates,
    completions,
    lineage,
    usageLedger,
    workItems,
    materializer,
    progression,
    objectiveAdmissionPort,
    outcomeVerificationPort,
    admissionStack,
    controlPlane,
  };
}

export async function admitSampleExperiment(
  service: ExperimentOrchestrationService,
  opts?: {
    sourceAssumptionIds?: string[];
    sourceAssumptionSetHash?: string;
    objective?: string;
    budgetEnvelope?: typeof DEFAULT_BUDGET;
  },
) {
  return service.admit({
    projectId: EXAMPLE_PROJECT_ID,
    requestedEnvironment: EXAMPLE_ENVIRONMENT,
    objective: opts?.objective ?? "Measure assumption latency under load",
    sourceAssumptionIds: opts?.sourceAssumptionIds ?? ["asm_latency"],
    ...(opts?.sourceAssumptionSetHash
      ? { sourceAssumptionSetHash: opts.sourceAssumptionSetHash }
      : {}),
    riskClass: "LOW",
    budgetEnvelope: { ...(opts?.budgetEnvelope ?? DEFAULT_BUDGET) },
    createdBy: "user_local",
    submittedAt: EXPERIMENT_TEST_NOW,
  });
}

export async function ladderToAuthorized(
  service: ExperimentOrchestrationService,
  opts?: { sourceAssumptionSetHash?: string },
) {
  const admitted = await admitSampleExperiment(service, {
    ...(opts?.sourceAssumptionSetHash
      ? { sourceAssumptionSetHash: opts.sourceAssumptionSetHash }
      : {}),
  });
  expect(admitted.outcome).toBe("ADMITTED");
  if (admitted.outcome !== "ADMITTED") {
    throw new Error("admit failed");
  }
  const id = admitted.experiment.experimentId;
  await service.design(id);
  await service.validate(id);
  const routed = await service.routeAuthorization(id);
  const decided = await service.decideAuthorization({
    authorizationId: routed.request.authorizationId,
    sponsorId: "sponsor_full",
    decision: "APPROVE_EXPERIMENT",
    decisionNonce: routed.decisionNonce,
    submittedAt: "2026-01-01T01:00:00.000Z",
  });
  return { id, decided, routed };
}
