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
  CausalOrchestrationService,
  CausalProgressionLoop,
  CausalWorkMaterializer,
  FakeCausalGraphProposalModel,
  InMemoryAuthoritativeExperimentEvidencePort,
  InMemoryCausalClaimCandidateRepository,
  InMemoryCausalEstimateRepository,
  InMemoryCausalEvidenceGapRepository,
  InMemoryCausalEvidenceReferenceRepository,
  InMemoryCausalEvidenceSynthesisRepository,
  InMemoryCausalGraphRepository,
  InMemoryCausalIdentificationAnalysisRepository,
  InMemoryCausalQuestionRepository,
  InMemoryCausalReviewRecordRepository,
  InMemoryCausalReviewRequestRepository,
  InMemoryCausalUsageLedgerRepository,
  InMemoryDecisionModelCalibrationCandidateRepository,
  InMemoryPromotedCausalClaimRepository,
  mintEvidenceRefId,
  mintSeededRandomizedEvidence,
  type CausalAdmissionRequest,
  type CausalEvidenceReference,
} from "./index.js";

const clock = new FixedClock("2026-08-14T12:00:00.000Z");
export const CAUSAL_TEST_NOW = "2026-01-01T00:00:00.000Z";
export const DEFAULT_SEEDED_EXPERIMENT_ID = "exp_seed_1";

export const DEFAULT_CAUSAL_BUDGET = {
  maximumGraphModelCalls: 10,
  maximumModelTokens: 10_000,
  maximumEstimators: 5,
  maximumSynthesisOperations: 5,
} as const;

export function buildCausalReviewerChecker(
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

const DEFAULT_REVIEWER_GRANTS = new Map<string, ReadonlySet<string>>([
  ["causal_reviewer_full", new Set([EXAMPLE_PROJECT_ID])],
  ["approver_only", new Set()],
]);

export function buildCausalService(opts?: {
  reviewerGrants?: ReadonlyMap<string, ReadonlySet<string>>;
  projects?: typeof EXAMPLE_PROJECT[];
  isCausalReviewer?: (
    principalId: string,
    projectIds: readonly string[],
  ) => Promise<boolean>;
  reviewWindowMs?: number;
  nowIso?: () => string;
  authoritativeExperimentEvidence?: InMemoryAuthoritativeExperimentEvidencePort;
}) {
  const questions = new InMemoryCausalQuestionRepository();
  const graphs = new InMemoryCausalGraphRepository();
  const evidenceRefs = new InMemoryCausalEvidenceReferenceRepository();
  const identifications = new InMemoryCausalIdentificationAnalysisRepository();
  const estimates = new InMemoryCausalEstimateRepository();
  const syntheses = new InMemoryCausalEvidenceSynthesisRepository();
  const claims = new InMemoryCausalClaimCandidateRepository();
  const reviewRequests = new InMemoryCausalReviewRequestRepository();
  const reviewRecords = new InMemoryCausalReviewRecordRepository();
  const promotedClaims = new InMemoryPromotedCausalClaimRepository();
  const calibrationCandidates =
    new InMemoryDecisionModelCalibrationCandidateRepository();
  const evidenceGaps = new InMemoryCausalEvidenceGapRepository();
  const usage = new InMemoryCausalUsageLedgerRepository();
  const workItems = new InMemorySchedulerWorkItemRepository();

  const controlPlaneProjects = opts?.projects ?? [EXAMPLE_PROJECT];
  const projects = new InMemoryProjectRegistry(controlPlaneProjects);
  const controlPlane = new ControlPlaneService({
    projects,
    capabilities: new InMemoryCapabilityRegistry(EXAMPLE_CAPABILITIES),
    policies: new InMemoryPolicyRegistry([EXAMPLE_POLICY_BUNDLE], { clock }),
    budgets: new InMemoryResourceBudgetRegistry([EXAMPLE_BUDGET]),
    clock,
  });

  const nowIso = opts?.nowIso ?? (() => CAUSAL_TEST_NOW);
  const authoritativeExperimentEvidence =
    opts?.authoritativeExperimentEvidence ??
    new InMemoryAuthoritativeExperimentEvidencePort();

  const service = new CausalOrchestrationService({
    nowIso,
    questions,
    graphs,
    evidenceRefs,
    identifications,
    estimates,
    syntheses,
    claims,
    reviewRequests,
    reviewRecords,
    promotedClaims,
    calibrationCandidates,
    evidenceGaps,
    usage,
    controlPlane,
    graphModel: new FakeCausalGraphProposalModel(),
    isCausalReviewer:
      opts?.isCausalReviewer ??
      buildCausalReviewerChecker(opts?.reviewerGrants ?? DEFAULT_REVIEWER_GRANTS),
    nonceGenerator: new SequenceDecisionNonceGenerator(),
    authoritativeExperimentEvidence,
    ...(opts?.reviewWindowMs !== undefined
      ? { reviewWindowMs: opts.reviewWindowMs }
      : {}),
  });

  const materializer = new CausalWorkMaterializer({
    nowIso,
    questions,
    graphs,
    identifications,
    claims,
    workItems,
    projectConfigs: new InMemorySchedulerProjectConfigRepository(),
  });

  const progression = new CausalProgressionLoop({
    questions,
    materializer,
  });

  return {
    service,
    questions,
    graphs,
    evidenceRefs,
    identifications,
    estimates,
    syntheses,
    claims,
    reviewRequests,
    reviewRecords,
    promotedClaims,
    calibrationCandidates,
    evidenceGaps,
    usage,
    workItems,
    materializer,
    progression,
    controlPlane,
    authoritativeExperimentEvidence,
  };
}

/** Build service with authoritative randomized evidence pre-seeded. */
export function buildCausalServiceWithSeededExperiment(
  experimentId: string = DEFAULT_SEEDED_EXPERIMENT_ID,
  opts?: Parameters<typeof buildCausalService>[0] & {
    evidenceOverrides?: Omit<
      Parameters<typeof mintSeededRandomizedEvidence>[0],
      "experimentId" | "projectId" | "environment"
    > &
      Partial<
        Pick<
          Parameters<typeof mintSeededRandomizedEvidence>[0],
          "projectId" | "environment"
        >
      >;
  },
) {
  const authoritative =
    opts?.authoritativeExperimentEvidence ??
    new InMemoryAuthoritativeExperimentEvidencePort();
  authoritative.seed(
    mintSeededRandomizedEvidence({
      experimentId,
      projectId: opts?.evidenceOverrides?.projectId ?? EXAMPLE_PROJECT_ID,
      environment:
        opts?.evidenceOverrides?.environment ?? EXAMPLE_ENVIRONMENT,
      outcomeUnit: opts?.evidenceOverrides?.outcomeUnit ?? "PERCENT",
      ...(opts?.evidenceOverrides?.experimentPlanHash
        ? { experimentPlanHash: opts.evidenceOverrides.experimentPlanHash }
        : {}),
      ...(opts?.evidenceOverrides?.treatmentMean !== undefined
        ? { treatmentMean: opts.evidenceOverrides.treatmentMean }
        : {}),
      ...(opts?.evidenceOverrides?.controlMean !== undefined
        ? { controlMean: opts.evidenceOverrides.controlMean }
        : {}),
      ...(opts?.evidenceOverrides?.treatmentSampleCount !== undefined
        ? {
            treatmentSampleCount: opts.evidenceOverrides.treatmentSampleCount,
          }
        : {}),
      ...(opts?.evidenceOverrides?.controlSampleCount !== undefined
        ? { controlSampleCount: opts.evidenceOverrides.controlSampleCount }
        : {}),
    }),
  );
  return buildCausalService({
    ...opts,
    authoritativeExperimentEvidence: authoritative,
  });
}

export function sampleAdmission(
  overrides?: Partial<CausalAdmissionRequest>,
): CausalAdmissionRequest {
  return {
    projectIds: [EXAMPLE_PROJECT_ID],
    intervention: "enable_feature_flag_x",
    outcome: "conversion_rate",
    interventionUnit: "DIMENSIONLESS",
    outcomeUnit: "PERCENT",
    targetPopulation: "users_us_west",
    targetEnvironment: EXAMPLE_ENVIRONMENT,
    timeHorizon: "14d",
    candidateConfounders: ["prior_engagement"],
    businessDecisionContext: "Decide whether to expand flag rollout",
    materialityThreshold: 1.0,
    budgetEnvelope: { ...DEFAULT_CAUSAL_BUDGET },
    createdBy: "analyst_local",
    ...overrides,
  };
}

export function randomizedEvidenceRef(input: {
  projectId?: string;
  populationScope?: string;
  environmentScope?: string;
  outcomeUnit?: string;
  treatmentMean?: number;
  controlMean?: number;
  treatmentSampleCount?: number;
  controlSampleCount?: number;
  createdAt?: string;
}): CausalEvidenceReference {
  const evidenceHash = "eh_randomized_validated_1";
  const sourceId = "exp_bundle_1";
  return {
    evidenceRefId: mintEvidenceRefId({
      sourceClass: "EXPERIMENT_EVIDENCE_BUNDLE",
      sourceId,
      evidenceHash,
    }),
    sourceClass: "EXPERIMENT_EVIDENCE_BUNDLE",
    sourceId,
    sourceVersion: "1",
    evidenceHash,
    projectId: input.projectId ?? EXAMPLE_PROJECT_ID,
    populationScope: input.populationScope ?? "users_us_west",
    environmentScope: input.environmentScope ?? EXAMPLE_ENVIRONMENT,
    timeRange: "experiment",
    quality: "VALIDATED",
    evidenceDesign: "RANDOMIZED_EXPERIMENT",
    verificationRefs: ["ovr_phase8_1"],
    treatmentMean: input.treatmentMean ?? 12,
    controlMean: input.controlMean ?? 8,
    treatmentSampleCount: input.treatmentSampleCount ?? 40,
    controlSampleCount: input.controlSampleCount ?? 40,
    outcomeUnit: input.outcomeUnit ?? "PERCENT",
    assignmentMethod: "simple_randomization",
    assignmentProvenance: "phase17_assignment_log",
    createdAt: input.createdAt ?? CAUSAL_TEST_NOW,
  };
}

export function observationalEvidenceRef(input?: {
  projectId?: string;
  populationScope?: string;
  environmentScope?: string;
  createdAt?: string;
}): CausalEvidenceReference {
  const evidenceHash = "eh_observational_1";
  const sourceId = "obs_metric_1";
  return {
    evidenceRefId: mintEvidenceRefId({
      sourceClass: "OBSERVATIONAL_METRIC",
      sourceId,
      evidenceHash,
    }),
    sourceClass: "OBSERVATIONAL_METRIC",
    sourceId,
    sourceVersion: "1",
    evidenceHash,
    projectId: input?.projectId ?? EXAMPLE_PROJECT_ID,
    populationScope: input?.populationScope ?? "users_us_west",
    environmentScope: input?.environmentScope ?? EXAMPLE_ENVIRONMENT,
    timeRange: "30d",
    quality: "PARTIAL",
    evidenceDesign: "OBSERVATIONAL",
    verificationRefs: [],
    createdAt: input?.createdAt ?? CAUSAL_TEST_NOW,
  };
}

/**
 * Happy-path ladder to AWAITING_CAUSAL_REVIEW via authoritative experiment
 * evidence. Does NOT rely on attachEvidence fabricated randomized samples.
 * Observational path: pass `observational: true` (attachEvidence only; identify
 * yields NOT_IDENTIFIED / INCONCLUSIVE — does not reach estimate).
 */
export async function ladderToAwaitingReview(
  service: CausalOrchestrationService,
  opts?: {
    admission?: Partial<CausalAdmissionRequest>;
    evidence?: CausalEvidenceReference;
    authoritativeExperimentEvidence?: InMemoryAuthoritativeExperimentEvidencePort;
    observational?: boolean;
  },
) {
  if (opts?.observational) {
    const admitted = await service.admit(sampleAdmission(opts?.admission));
    const id = admitted.question.causalQuestionId;
    await service.proposeGraph(id);
    await service.attachEvidence(id, [
      opts?.evidence ?? observationalEvidenceRef({}),
    ]);
    const identified = await service.identify(id);
    return { id, admitted, validated: undefined, identified };
  }

  const experimentId =
    opts?.admission?.sourceExperimentIds?.[0] ?? DEFAULT_SEEDED_EXPERIMENT_ID;
  if (opts?.authoritativeExperimentEvidence) {
    opts.authoritativeExperimentEvidence.seed(
      mintSeededRandomizedEvidence({
        experimentId,
        projectId: EXAMPLE_PROJECT_ID,
        environment: EXAMPLE_ENVIRONMENT,
        outcomeUnit: "PERCENT",
      }),
    );
  }

  const admitted = await service.admit(
    sampleAdmission({
      ...opts?.admission,
      sourceExperimentIds:
        opts?.admission?.sourceExperimentIds ?? [experimentId],
    }),
  );
  const id = admitted.question.causalQuestionId;
  await service.proposeGraph(id);
  // Optional observational attach only — never used as randomization authority.
  if (opts?.evidence) {
    await service.attachEvidence(id, [opts.evidence]);
  }
  await service.identify(id);
  await service.estimate(id);
  await service.synthesize(id);
  const validated = await service.validate(id);
  return { id, admitted, validated };
}
