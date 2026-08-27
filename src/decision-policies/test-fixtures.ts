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
import { SequenceDecisionNonceGenerator } from "../authorization/decision-nonce.js";
import {
  InMemorySchedulerProjectConfigRepository,
  InMemorySchedulerWorkItemRepository,
} from "../scheduling/index.js";
import {
  DecisionPolicyOrchestrationService,
  FakeDecisionPolicySynthesisModel,
  InMemoryCausalGovernedEvidencePort,
  InMemoryDecisionContextRepository,
  InMemoryDecisionOverrideRecordRepository,
  InMemoryDecisionPolicyActivationRecordRepository,
  InMemoryDecisionPolicyActivationRequestRepository,
  InMemoryDecisionPolicyApprovalRecordRepository,
  InMemoryDecisionPolicyApprovalRequestRepository,
  InMemoryDecisionPolicyCandidateRepository,
  InMemoryDecisionPolicyComparisonRepository,
  InMemoryDecisionPolicyEvaluationRepository,
  InMemoryDecisionPolicyPerformanceRecordRepository,
  InMemoryDecisionPolicyRevisionCandidateRepository,
  InMemoryDecisionPolicyShadowEvaluationRepository,
  InMemoryDecisionPolicyShadowRecordRepository,
  InMemoryDecisionRecommendationMaterializationLineageRepository,
  InMemoryDecisionRecommendationRepository,
  InMemoryDecisionStateSnapshotRepository,
  InMemoryDecisionStateSourcePort,
  DecisionPolicyProgressionLoop,
  DecisionPolicyWorkMaterializer,
  defaultNoActionDefinition,
  mintSeededObservation,
  type CausalGovernedEvidencePort,
  type DecisionActionDefinition,
  type DecisionRecommendationCompilerDeps,
  type DecisionStateVariable,
} from "./index.js";

const clock = new FixedClock("2026-08-14T12:00:00.000Z");
export const DP_TEST_NOW = "2026-01-01T00:00:00.000Z";

export function buildDecisionPolicyApproverChecker(
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

const DEFAULT_APPROVER_GRANTS = new Map<string, ReadonlySet<string>>([
  ["dp_approver_full", new Set([EXAMPLE_PROJECT_ID])],
  ["approver_only", new Set()],
]);

const DEFAULT_ACTIVATOR_GRANTS = new Map<string, ReadonlySet<string>>([
  ["dp_activator_full", new Set([EXAMPLE_PROJECT_ID])],
  ["dp_approver_full", new Set()],
]);

export function sampleStateVariables(): DecisionStateVariable[] {
  return [
    {
      variableId: "conversion_rate",
      name: "Conversion rate",
      description: "Verified conversion rate",
      unit: "PERCENT",
      sourceClass: "VERIFIED_PROGRAM_OUTCOME",
      sourceRef: "ovr_conversion",
      measurementDefinition: "conversions / visitors * 100",
      freshnessRequirementMs: 86_400_000,
      qualityRequirement: "VALIDATED",
      missingValuePolicy: "FAIL_CLOSED",
    },
    {
      variableId: "flag_enabled",
      name: "Feature flag",
      description: "Whether flag is enabled",
      unit: "DIMENSIONLESS",
      sourceClass: "CURRENT_CONTROL_PLANE_TRUTH",
      sourceRef: "cp_flag",
      measurementDefinition: "boolean flag",
      freshnessRequirementMs: 3_600_000,
      qualityRequirement: "ANY",
      missingValuePolicy: "NO_ACTION",
    },
  ];
}

export function sampleEligibleActions(): DecisionActionDefinition[] {
  return [
    defaultNoActionDefinition({
      projectIds: [EXAMPLE_PROJECT_ID],
      environments: [EXAMPLE_ENVIRONMENT],
    }),
    {
      actionId: "action_create_objective",
      name: "Create objective",
      description: "Recommend Phase 2 objective admission",
      actionClass: "CREATE_OBJECTIVE",
      requiredCapabilities: [],
      projectScope: [EXAMPLE_PROJECT_ID],
      environmentScope: [EXAMPLE_ENVIRONMENT],
      estimatedResources: { tokens: 100 },
      reversibility: "REVERSIBLE",
      riskClass: "MEDIUM",
      executionPath: "OBJECTIVE",
      authorityRequirements: ["PHASE_6_APPROVAL"],
    },
  ];
}

export function buildDecisionPolicyService(opts?: {
  approverGrants?: ReadonlyMap<string, ReadonlySet<string>>;
  activatorGrants?: ReadonlyMap<string, ReadonlySet<string>>;
  nowIso?: () => string;
  causalEvidence?: CausalGovernedEvidencePort;
  compilerDeps?: DecisionRecommendationCompilerDeps;
  seedDefaultState?: boolean;
}) {
  const contexts = new InMemoryDecisionContextRepository();
  const policies = new InMemoryDecisionPolicyCandidateRepository();
  const evaluations = new InMemoryDecisionPolicyEvaluationRepository();
  const comparisons = new InMemoryDecisionPolicyComparisonRepository();
  const approvalRequests = new InMemoryDecisionPolicyApprovalRequestRepository();
  const approvalRecords = new InMemoryDecisionPolicyApprovalRecordRepository();
  const shadowRecords = new InMemoryDecisionPolicyShadowRecordRepository();
  const shadowEvaluations =
    new InMemoryDecisionPolicyShadowEvaluationRepository();
  const activationRequests =
    new InMemoryDecisionPolicyActivationRequestRepository();
  const activationRecords =
    new InMemoryDecisionPolicyActivationRecordRepository();
  const snapshots = new InMemoryDecisionStateSnapshotRepository();
  const recommendations = new InMemoryDecisionRecommendationRepository();
  const overrides = new InMemoryDecisionOverrideRecordRepository();
  const performance = new InMemoryDecisionPolicyPerformanceRecordRepository();
  const revisions = new InMemoryDecisionPolicyRevisionCandidateRepository();
  const materializationLineages =
    new InMemoryDecisionRecommendationMaterializationLineageRepository();
  const workItems = new InMemorySchedulerWorkItemRepository();
  const decisionStateSource = new InMemoryDecisionStateSourcePort();
  const nowIso = opts?.nowIso ?? (() => DP_TEST_NOW);
  if (opts?.seedDefaultState !== false) {
    decisionStateSource.seed(
      mintSeededObservation({
        variableId: "conversion_rate",
        value: 12,
        unit: "PERCENT",
        sourceClass: "VERIFIED_PROGRAM_OUTCOME",
        projectId: EXAMPLE_PROJECT_ID,
        environment: EXAMPLE_ENVIRONMENT,
        observedAt: nowIso(),
        quality: "VALIDATED",
        sourceHash: "sh_conversion_auth",
      }),
    );
    decisionStateSource.seed(
      mintSeededObservation({
        variableId: "flag_enabled",
        value: true,
        unit: "DIMENSIONLESS",
        sourceClass: "CURRENT_CONTROL_PLANE_TRUTH",
        projectId: EXAMPLE_PROJECT_ID,
        environment: EXAMPLE_ENVIRONMENT,
        observedAt: nowIso(),
        quality: "VALIDATED",
        sourceHash: "sh_flag_auth",
      }),
    );
  }

  const controlPlane = new ControlPlaneService({
    projects: new InMemoryProjectRegistry([EXAMPLE_PROJECT]),
    capabilities: new InMemoryCapabilityRegistry(EXAMPLE_CAPABILITIES),
    policies: new InMemoryPolicyRegistry([EXAMPLE_POLICY_BUNDLE], { clock }),
    budgets: new InMemoryResourceBudgetRegistry([EXAMPLE_BUDGET]),
    clock,
  });

  const service = new DecisionPolicyOrchestrationService({
    nowIso,
    contexts,
    policies,
    evaluations,
    comparisons,
    approvalRequests,
    approvalRecords,
    shadowRecords,
    shadowEvaluations,
    activationRequests,
    activationRecords,
    snapshots,
    recommendations,
    overrides,
    performance,
    revisions,
    controlPlane,
    synthesisModel: new FakeDecisionPolicySynthesisModel(),
    isDecisionPolicyApprover: buildDecisionPolicyApproverChecker(
      opts?.approverGrants ?? DEFAULT_APPROVER_GRANTS,
    ),
    isDecisionPolicyActivator: buildDecisionPolicyApproverChecker(
      opts?.activatorGrants ?? DEFAULT_ACTIVATOR_GRANTS,
    ),
    nonceGenerator: new SequenceDecisionNonceGenerator(),
    decisionStateSource,
    ...(opts?.causalEvidence ? { causalEvidence: opts.causalEvidence } : {}),
    compilerDeps: opts?.compilerDeps ?? { allowMaterialization: false },
    materializationLineages,
  });

  const materializer = new DecisionPolicyWorkMaterializer({
    nowIso,
    policies,
    workItems,
    projectConfigs: new InMemorySchedulerProjectConfigRepository(),
  });
  const progression = new DecisionPolicyProgressionLoop({
    policies,
    materializer,
  });

  return {
    service,
    contexts,
    policies,
    evaluations,
    comparisons,
    approvalRequests,
    approvalRecords,
    shadowRecords,
    shadowEvaluations,
    activationRequests,
    activationRecords,
    snapshots,
    recommendations,
    overrides,
    performance,
    revisions,
    workItems,
    materializer,
    progression,
    controlPlane,
    decisionStateSource,
    materializationLineages,
  };
}

export async function admitSampleContext(
  service: DecisionPolicyOrchestrationService,
) {
  return service.admitContext({
    projectIds: [EXAMPLE_PROJECT_ID],
    environmentScope: [EXAMPLE_ENVIRONMENT],
    stateVariables: sampleStateVariables(),
    eligibleActions: sampleEligibleActions(),
    optimizationObjectives: [
      {
        objectiveId: "obj_conversion",
        name: "Maximize conversion",
        direction: "MAXIMIZE",
        unit: "PERCENT",
        weight: 1,
      },
    ],
    riskTolerance: "MEDIUM",
    materialityThreshold: 10,
    timeHorizon: "14d",
    createdBy: "requester_test",
    nonGoals: ["Auto-mutate governance policy"],
    constraints: ["No direct execution"],
  });
}
