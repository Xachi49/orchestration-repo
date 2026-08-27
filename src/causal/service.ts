import type { ControlPlaneService } from "../control-plane/service.js";
import {
  issueDecisionNonce,
  type DecisionNonceGenerator,
} from "../authorization/decision-nonce.js";
import { hashDecisionNonce } from "../authorization/decision-card-hasher.js";
import { capabilitySetFingerprint } from "../execution/capability-fingerprint.js";
import {
  withOptionalTransaction,
  type TransactionManager,
} from "../durability/transaction.js";
import { reserveCausalUsage } from "./budget-ledger.js";
import {
  assessGeneralizability,
  assessMateriality,
  classifyClaimType,
  mintClaimId,
  withClaimHash,
  type CausalClaimCandidate,
} from "./claim.js";
import {
  mintCalibrationCandidateId,
  mintEvidenceGapId,
  withCalibrationCandidateHash,
  type CausalEvidenceGap,
  type DecisionModelCalibrationCandidate,
} from "./calibration.js";
import { CAUSAL_DOCTRINE } from "./doctrine.js";
import { CausalError } from "./errors.js";
import {
  mintEvidenceRefId,
  type CausalEvidenceReference,
} from "./evidence.js";
import {
  DifferenceInMeansEstimator,
  type CausalEstimate,
} from "./estimator.js";
import {
  mintCausalGraphId,
  withCausalGraphHash,
  type CausalGraph,
} from "./graph.js";
import {
  mintEdgeId,
  type CausalGraphProposalModel,
} from "./graph-model.js";
import { validateCausalGraph } from "./graph-validator.js";
import {
  computeIdentificationFingerprint,
  mintIdentificationAnalysisId,
  type CausalIdentificationAnalysis,
  type IdentificationAssumption,
  type IdentificationStatus,
  type IdentificationStrategy,
} from "./identification.js";
import {
  assertPromotionCompatibleWithSynthesis,
  computePromotionBasisHash,
  mintPromotedCausalClaimId,
  PROMOTED_CAUSAL_CLAIM_BOUNDARIES,
  type PromotedCausalClaim,
} from "./promotion.js";
import {
  assertCausalQuestionTransition,
  causalQuestionContentFingerprint,
  causalQuestionIdempotencyKey,
  INITIAL_CAUSAL_QUESTION_VERSION,
  mintCausalQuestionId,
  parseCausalQuestion,
  type CausalQuestion,
} from "./question.js";
import type {
  CausalClaimCandidateRepository,
  CausalEstimateRepository,
  CausalEvidenceGapRepository,
  CausalEvidenceReferenceRepository,
  CausalEvidenceSynthesisRepository,
  CausalGraphRepository,
  CausalIdentificationAnalysisRepository,
  CausalQuestionRepository,
  CausalReviewRecordRepository,
  CausalReviewRequestRepository,
  CausalUsageLedgerRepository,
  DecisionModelCalibrationCandidateRepository,
  PromotedCausalClaimRepository,
} from "./repositories.js";
import {
  CAUSAL_REVIEWER_AUTHORITY_BOUNDARIES,
  computeCausalReviewSubjectHash,
  mintCausalReviewRecordId,
  mintCausalReviewRequestId,
  type CausalReviewDecision,
  type CausalReviewRecord,
  type CausalReviewRequest,
} from "./review.js";
import { synthesizeEstimates, type CausalEvidenceSynthesis } from "./synthesis.js";
import { INITIAL_CAUSAL_GRAPH_VERSION } from "./graph.js";
import type {
  AuthoritativeExperimentEvidencePort,
  ResolvedRandomizedEvidence,
} from "./verified-evidence.js";

const DEFAULT_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CausalAdmissionRequest {
  causalQuestionId?: string;
  projectIds: string[];
  sourceDecisionProblemIds?: string[];
  sourceExperimentIds?: string[];
  sourceAssumptionIds?: string[];
  intervention: string;
  outcome: string;
  interventionUnit: CausalQuestion["interventionUnit"];
  outcomeUnit: CausalQuestion["outcomeUnit"];
  targetPopulation: string;
  targetEnvironment: string;
  timeHorizon: string;
  candidateConfounders?: string[];
  candidateMediators?: string[];
  candidateModerators?: string[];
  businessDecisionContext: string;
  materialityThreshold: number;
  constraints?: string[];
  nonGoals?: string[];
  budgetEnvelope: CausalQuestion["budgetEnvelope"];
  createdBy: string;
  correlationId?: string;
  traceId?: string;
}

export interface CausalOrchestrationDeps {
  nowIso: () => string;
  questions: CausalQuestionRepository;
  graphs: CausalGraphRepository;
  evidenceRefs: CausalEvidenceReferenceRepository & {
    bindQuestion?(causalQuestionId: string, evidenceRefId: string): void;
  };
  identifications: CausalIdentificationAnalysisRepository;
  estimates: CausalEstimateRepository;
  syntheses: CausalEvidenceSynthesisRepository;
  claims: CausalClaimCandidateRepository;
  reviewRequests: CausalReviewRequestRepository;
  reviewRecords: CausalReviewRecordRepository;
  promotedClaims: PromotedCausalClaimRepository;
  calibrationCandidates: DecisionModelCalibrationCandidateRepository;
  evidenceGaps: CausalEvidenceGapRepository;
  usage: CausalUsageLedgerRepository;
  controlPlane: ControlPlaneService;
  graphModel: CausalGraphProposalModel;
  /** Must hold CAUSAL_REVIEWER for ALL affected projects. */
  isCausalReviewer?: (
    principalId: string,
    projectIds: readonly string[],
  ) => Promise<boolean>;
  nonceGenerator?: DecisionNonceGenerator;
  reviewWindowMs?: number;
  transactions?: TransactionManager;
  /**
   * Authoritative Phase 17 experiment evidence for RANDOMIZED_TREATMENT.
   * CALLER-SUPPLIED SAMPLE VALUES != CAUSAL ESTIMATION AUTHORITY.
   */
  authoritativeExperimentEvidence?: AuthoritativeExperimentEvidencePort;
}

export class CausalOrchestrationService {
  private readonly reviewWindowMs: number;
  private readonly estimator = new DifferenceInMeansEstimator();
  private readonly noncePlaintextByRequest = new Map<string, string>();

  constructor(private readonly deps: CausalOrchestrationDeps) {
    this.reviewWindowMs = deps.reviewWindowMs ?? DEFAULT_REVIEW_WINDOW_MS;
    void CAUSAL_DOCTRINE;
    void CAUSAL_REVIEWER_AUTHORITY_BOUNDARIES;
    void PROMOTED_CAUSAL_CLAIM_BOUNDARIES;
  }

  async admit(
    request: CausalAdmissionRequest,
  ): Promise<{ question: CausalQuestion; reused: boolean }> {
    const createdAt = this.deps.nowIso();
    const contentFingerprint = causalQuestionContentFingerprint({
      projectIds: request.projectIds,
      intervention: request.intervention,
      outcome: request.outcome,
      targetPopulation: request.targetPopulation,
      targetEnvironment: request.targetEnvironment,
      timeHorizon: request.timeHorizon,
      materialityThreshold: request.materialityThreshold,
    });
    const idempotencyKey = causalQuestionIdempotencyKey({
      contentFingerprint,
      createdBy: request.createdBy,
    });
    const existing = await this.deps.questions.findByIdempotencyKey(
      idempotencyKey,
    );
    if (existing) {
      return { question: existing, reused: true };
    }

    for (const projectId of request.projectIds) {
      await this.deps.controlPlane.resolve(
        projectId,
        request.targetEnvironment,
      );
    }

    const causalQuestionId =
      request.causalQuestionId ??
      mintCausalQuestionId({
        projectIds: request.projectIds,
        intervention: request.intervention,
        outcome: request.outcome,
        createdAt,
      });
    const question = parseCausalQuestion({
      causalQuestionId,
      causalQuestionVersion: INITIAL_CAUSAL_QUESTION_VERSION,
      projectIds: request.projectIds,
      sourceDecisionProblemIds: request.sourceDecisionProblemIds ?? [],
      sourceExperimentIds: request.sourceExperimentIds ?? [],
      sourceAssumptionIds: request.sourceAssumptionIds ?? [],
      intervention: request.intervention,
      outcome: request.outcome,
      interventionUnit: request.interventionUnit,
      outcomeUnit: request.outcomeUnit,
      targetPopulation: request.targetPopulation,
      targetEnvironment: request.targetEnvironment,
      timeHorizon: request.timeHorizon,
      candidateConfounders: request.candidateConfounders ?? [],
      candidateMediators: request.candidateMediators ?? [],
      candidateModerators: request.candidateModerators ?? [],
      businessDecisionContext: request.businessDecisionContext,
      materialityThreshold: request.materialityThreshold,
      constraints: request.constraints ?? [],
      nonGoals: request.nonGoals ?? [],
      budgetEnvelope: request.budgetEnvelope,
      createdBy: request.createdBy,
      createdAt,
      updatedAt: createdAt,
      status: "ADMITTED",
      idempotencyKey,
      contentFingerprint,
      recordRevision: 1,
      ...(request.correlationId
        ? { correlationId: request.correlationId }
        : {}),
      ...(request.traceId ? { traceId: request.traceId } : {}),
    });
    await this.deps.questions.save(question);
    return { question, reused: false };
  }

  async proposeGraph(causalQuestionId: string): Promise<{
    question: CausalQuestion;
    graph: CausalGraph;
  }> {
    const question = await this.requireQuestion(causalQuestionId);
    if (question.status !== "ADMITTED" && question.status !== "STALE") {
      if (question.status === "GRAPH_PROPOSED") {
        const existing = await this.deps.graphs.getLatestByQuestion(
          causalQuestionId,
        );
        if (existing) return { question, graph: existing };
      }
      throw new CausalError(
        "CAUSAL_STATE_CONFLICT",
        `proposeGraph requires ADMITTED (got ${question.status})`,
      );
    }
    await reserveCausalUsage({
      ledger: this.deps.usage,
      causalQuestionId,
      budget: question.budgetEnvelope,
      delta: { graphModelCalls: 1, modelTokens: 100 },
      nowIso: this.deps.nowIso(),
    });
    const proposal = await this.deps.graphModel.propose({ question });
    void proposal.untrustedSuggestedIdentified;
    const edges = proposal.edges.map((e) => ({
      edgeId: mintEdgeId(e),
      fromVariableId: e.fromVariableId,
      toVariableId: e.toVariableId,
      edgeType: e.edgeType,
      provenance: e.provenance,
      ...(e.note ? { note: e.note } : {}),
    }));
    const graph = withCausalGraphHash({
      causalGraphId: mintCausalGraphId({
        causalQuestionId,
        causalGraphVersion: INITIAL_CAUSAL_GRAPH_VERSION,
      }),
      causalGraphVersion: INITIAL_CAUSAL_GRAPH_VERSION,
      causalQuestionId,
      causalQuestionVersion: question.causalQuestionVersion,
      nodes: proposal.nodes,
      edges,
      createdAt: this.deps.nowIso(),
      createdBy: this.deps.graphModel.modelId,
    });
    const validation = validateCausalGraph(graph, question);
    if (validation.outcome === "BLOCK") {
      throw new CausalError(
        "CAUSAL_GRAPH_INVALID",
        validation.reasons.join("; "),
        { reasons: validation.reasons },
      );
    }
    await this.deps.graphs.save(graph);
    const next = await this.transition(question, "GRAPH_PROPOSED");
    return { question: next, graph };
  }

  async attachEvidence(
    causalQuestionId: string,
    refs: CausalEvidenceReference[],
  ): Promise<CausalEvidenceReference[]> {
    await this.requireQuestion(causalQuestionId);
    const saved: CausalEvidenceReference[] = [];
    for (const ref of refs) {
      const stored = await this.deps.evidenceRefs.save(ref);
      this.deps.evidenceRefs.bindQuestion?.(
        causalQuestionId,
        stored.evidenceRefId,
      );
      saved.push(stored);
    }
    return saved;
  }

  async identify(causalQuestionId: string): Promise<{
    question: CausalQuestion;
    analysis: CausalIdentificationAnalysis;
    evidenceGap?: CausalEvidenceGap;
  }> {
    const question = await this.requireQuestion(causalQuestionId);
    if (
      question.status !== "GRAPH_PROPOSED" &&
      question.status !== "IDENTIFICATION_ANALYSIS"
    ) {
      throw new CausalError(
        "CAUSAL_STATE_CONFLICT",
        `identify requires GRAPH_PROPOSED (got ${question.status})`,
      );
    }
    const graph = await this.deps.graphs.getLatestByQuestion(causalQuestionId);
    if (!graph) {
      throw new CausalError("CAUSAL_GRAPH_INVALID", "Graph missing");
    }
    const attached = await this.deps.evidenceRefs.listByQuestion(
      causalQuestionId,
    );

    const resolvedAuthoritative =
      await this.tryResolveAuthoritativeForIdentification(question);
    const authoritativeRefs = resolvedAuthoritative
      ? await this.persistAuthoritativeEvidenceRefs(
          question,
          resolvedAuthoritative,
        )
      : [];

    let analysis: CausalIdentificationAnalysis;
    let evidenceGap: CausalEvidenceGap | undefined;
    if (resolvedAuthoritative && resolvedAuthoritative.length > 0) {
      analysis = this.buildRandomizedAnalysis(
        question,
        graph,
        authoritativeRefs,
        resolvedAuthoritative,
      );
    } else {
      // Observational / fabricated attachEvidence is never RANDOMIZED authority.
      const backdoor = this.tryBackdoorIdentification(
        question,
        graph,
        attached,
      );
      analysis =
        backdoor ?? this.notIdentified(question, graph, attached);
      if (analysis.status === "NOT_IDENTIFIED") {
        evidenceGap = {
          evidenceGapId: mintEvidenceGapId(causalQuestionId),
          causalQuestionId,
          missingAssumption: "no_unmeasured_confounding_or_randomization",
          missingConfounderMeasurement:
            question.candidateConfounders[0] ?? "unmeasured_confounder",
          insufficientSample: attached.length === 0,
          scopeGap: undefined,
          contradictoryEvidence: false,
          recommendedExperimentCharacteristics: [
            "RANDOMIZED_TREATMENT",
            "verified Phase 8 outcome binding",
            "explicit assignment provenance",
            "authoritative ExperimentEvidenceBundle resolution",
          ],
          mayFeedPhase17ActiveLearning: true,
          doesNotAuthorizeExperiment: true,
          createdAt: this.deps.nowIso(),
        };
        await this.deps.evidenceGaps.save(evidenceGap);
      }
    }
    await this.deps.identifications.save(analysis);
    const nextStatus =
      analysis.status === "IDENTIFIED" ||
      analysis.status === "PARTIALLY_IDENTIFIED"
        ? "ESTIMATING"
        : "INCONCLUSIVE";
    const next = await this.transition(
      question.status === "IDENTIFICATION_ANALYSIS"
        ? question
        : await this.transition(question, "IDENTIFICATION_ANALYSIS"),
      nextStatus,
    );
    return {
      question: next,
      analysis,
      ...(evidenceGap ? { evidenceGap } : {}),
    };
  }

  async estimate(causalQuestionId: string): Promise<{
    question: CausalQuestion;
    estimate: CausalEstimate;
  }> {
    const question = await this.requireQuestion(causalQuestionId);
    if (question.status !== "ESTIMATING") {
      throw new CausalError(
        "CAUSAL_STATE_CONFLICT",
        `estimate requires ESTIMATING (got ${question.status})`,
      );
    }
    const analysis = await this.deps.identifications.getLatestByQuestion(
      causalQuestionId,
    );
    if (!analysis || analysis.status !== "IDENTIFIED") {
      throw new CausalError(
        "NOT_IDENTIFIED",
        "Cannot estimate without IDENTIFIED analysis",
      );
    }
    if (analysis.strategy !== "RANDOMIZED_TREATMENT") {
      throw new CausalError(
        "UNSUPPORTED_ESTIMATOR",
        "Only DifferenceInMeans for RANDOMIZED_TREATMENT is implemented",
      );
    }
    const graph = await this.deps.graphs.getLatestByQuestion(causalQuestionId);
    if (!graph) {
      throw new CausalError("CAUSAL_GRAPH_INVALID", "Graph missing");
    }

    // Reject fabricated attachEvidence samples as estimation authority.
    const attached = await this.deps.evidenceRefs.listByQuestion(
      causalQuestionId,
    );
    const fabricatedOnly =
      attached.some(
        (e) =>
          e.treatmentMean !== undefined &&
          e.controlMean !== undefined &&
          e.sourceClass !== "EXPERIMENT_EVIDENCE_BUNDLE",
      ) && question.sourceExperimentIds.length === 0;
    if (fabricatedOnly || !this.deps.authoritativeExperimentEvidence) {
      throw new CausalError(
        "CAUSAL_EVIDENCE_INVALID",
        "Estimation requires authoritative ExperimentEvidenceBundle resolution; caller-attached samples are not authority",
      );
    }

    await reserveCausalUsage({
      ledger: this.deps.usage,
      causalQuestionId,
      budget: question.budgetEnvelope,
      delta: { estimators: 1 },
      nowIso: this.deps.nowIso(),
    });

    const resolved = await this.resolveAuthoritativeRandomized(question);
    if (!question.sourceExperimentIds.includes(resolved.experimentId)) {
      throw new CausalError(
        "CAUSAL_EVIDENCE_INVALID",
        "Resolved experimentId is not in causal question sourceExperimentIds",
        {
          experimentId: resolved.experimentId,
          sourceExperimentIds: question.sourceExperimentIds,
        },
      );
    }

    const evidenceRefIds = analysis.evidenceRefIds.length
      ? analysis.evidenceRefIds
      : (
          await this.persistAuthoritativeEvidenceRefs(question, [resolved])
        ).map((r) => r.evidenceRefId);

    const estimate = this.estimator.estimate({
      treatmentMeasurements: resolved.treatmentMeasurements,
      controlMeasurements: resolved.controlMeasurements,
      unit: question.outcomeUnit,
      evidenceRefIds,
      createdAt: this.deps.nowIso(),
      causalQuestionId,
      causalQuestionVersion: question.causalQuestionVersion,
      intervention: question.intervention,
      outcome: question.outcome,
      graphHash: graph.graphHash,
      identificationAnalysisId: analysis.identificationAnalysisId,
      identificationFingerprint: analysis.identificationFingerprint,
      identificationStrategy: analysis.strategy,
      evidenceBundleId: resolved.evidenceBundleId,
      evidenceBundleHash: resolved.evidenceBundleHash,
      outcomeVerificationIds: resolved.outcomeVerificationIds,
      assignmentFingerprint: resolved.assignmentFingerprint,
      measurementDefinition: question.outcome,
      populationScope: resolved.populationScope,
      environmentScope: resolved.environmentScope,
    });
    await this.deps.estimates.save(estimate);
    const next = await this.transition(question, "SYNTHESIZING");
    return { question: next, estimate };
  }

  async synthesize(causalQuestionId: string): Promise<{
    question: CausalQuestion;
    synthesis: CausalEvidenceSynthesis;
  }> {
    const question = await this.requireQuestion(causalQuestionId);
    if (question.status !== "SYNTHESIZING") {
      throw new CausalError(
        "CAUSAL_STATE_CONFLICT",
        `synthesize requires SYNTHESIZING (got ${question.status})`,
      );
    }
    await reserveCausalUsage({
      ledger: this.deps.usage,
      causalQuestionId,
      budget: question.budgetEnvelope,
      delta: { synthesisOperations: 1 },
      nowIso: this.deps.nowIso(),
    });
    const estimates = await this.deps.estimates.listByQuestion(causalQuestionId);
    const synthesis = synthesizeEstimates({
      causalQuestionId,
      estimates,
      materialityThreshold: question.materialityThreshold,
      createdAt: this.deps.nowIso(),
    });
    await this.deps.syntheses.save(synthesis);
    const next = await this.transition(question, "VALIDATING");
    return { question: next, synthesis };
  }

  async validate(causalQuestionId: string): Promise<{
    question: CausalQuestion;
    claim: CausalClaimCandidate;
    decision: "PASS" | "BLOCK" | "HUMAN_REVIEW_REQUIRED" | "REVISE";
  }> {
    const question = await this.requireQuestion(causalQuestionId);
    if (question.status !== "VALIDATING") {
      throw new CausalError(
        "CAUSAL_STATE_CONFLICT",
        `validate requires VALIDATING (got ${question.status})`,
      );
    }
    const graph = await this.deps.graphs.getLatestByQuestion(causalQuestionId);
    const analysis = await this.deps.identifications.getLatestByQuestion(
      causalQuestionId,
    );
    const synthesis = await this.deps.syntheses.getLatestByQuestion(
      causalQuestionId,
    );
    const estimates = await this.deps.estimates.listByQuestion(causalQuestionId);
    if (!graph || !analysis || !synthesis) {
      throw new CausalError(
        "CAUSAL_VALIDATION_FAILED",
        "Missing graph/identification/synthesis for validation",
      );
    }
    const estimate = estimates[0];
    const evidence = await this.deps.evidenceRefs.listByQuestion(
      causalQuestionId,
    );
    const primaryEvidence = evidence[0];
    const generalizability = assessGeneralizability({
      evidencePopulation:
        primaryEvidence?.populationScope ??
        estimate?.populationScope ??
        question.targetPopulation,
      evidenceEnvironment:
        primaryEvidence?.environmentScope ??
        estimate?.environmentScope ??
        question.targetEnvironment,
      targetPopulation: question.targetPopulation,
      targetEnvironment: question.targetEnvironment,
    });
    const materiality = assessMateriality({
      effectEstimate: estimate?.pointEstimate,
      threshold: question.materialityThreshold,
      ...(estimate?.uncertainty.standardError !== undefined
        ? { se: estimate.uncertainty.standardError }
        : {}),
    });
    const intervention = graph.nodes.find(
      (n) => n.variableClass === "INTERVENTION",
    );
    const outcome = graph.nodes.find((n) => n.variableClass === "OUTCOME");
    if (!intervention || !outcome) {
      throw new CausalError(
        "CAUSAL_VALIDATION_FAILED",
        "Graph missing intervention/outcome nodes",
      );
    }
    const claimType = classifyClaimType({
      identificationStatus: analysis.status,
      ...(estimate ? { effectEstimate: estimate.pointEstimate } : {}),
      materialityThreshold: question.materialityThreshold,
      synthesisStatus: synthesis.synthesisStatus,
    });
    const claim = withClaimHash({
      claimId: mintClaimId({
        causalQuestionId,
        claimVersion: 1,
      }),
      claimVersion: 1,
      causalQuestionId,
      causalQuestionVersion: question.causalQuestionVersion,
      interventionVariableId: intervention.variableId,
      outcomeVariableId: outcome.variableId,
      claimType,
      ...(estimate
        ? {
            effectEstimate: estimate.pointEstimate,
            unit: estimate.unit,
            uncertainty: estimate.uncertainty,
          }
        : {}),
      identificationStatus: analysis.status,
      identificationStrategy: analysis.strategy,
      graphId: graph.causalGraphId,
      graphVersion: graph.causalGraphVersion,
      graphHash: graph.graphHash,
      identificationAnalysisId: analysis.identificationAnalysisId,
      evidenceSynthesisId: synthesis.evidenceSynthesisId,
      assumptionIds: analysis.assumptions.map((a) => a.assumptionId),
      evidenceRefs: evidence.map((e) => e.evidenceRefId),
      populationScope: question.targetPopulation,
      environmentScope: question.targetEnvironment,
      timeScope: question.timeHorizon,
      statisticalEvidenceAssessment: materiality.statistical,
      businessMaterialityAssessment: materiality.business,
      generalizability,
      limitations: [
        ...analysis.limitations,
        ...synthesis.limitations,
        ...(estimate?.limitations ?? []),
      ],
      contradictoryEvidenceRefs: synthesis.contradictingEstimateIds,
      createdAt: this.deps.nowIso(),
    });
    await this.deps.claims.save(claim);

    let decision: "PASS" | "BLOCK" | "HUMAN_REVIEW_REQUIRED" | "REVISE" =
      "HUMAN_REVIEW_REQUIRED";
    if (analysis.status === "NOT_IDENTIFIED") {
      decision = "BLOCK";
    } else if (synthesis.synthesisStatus === "CONTRADICTORY") {
      decision = "HUMAN_REVIEW_REQUIRED";
    } else if (
      generalizability.status === "NOT_SUPPORTED" ||
      generalizability.status === "EXTRAPOLATED"
    ) {
      decision = "HUMAN_REVIEW_REQUIRED";
    }

    if (decision === "BLOCK") {
      const next = await this.transition(question, "INCONCLUSIVE");
      return { question: next, claim, decision };
    }
    const next = await this.transition(question, "AWAITING_CAUSAL_REVIEW");
    return { question: next, claim, decision };
  }

  async routeReview(causalQuestionId: string): Promise<{
    request: CausalReviewRequest;
    decisionNonce: string;
  }> {
    const question = await this.requireQuestion(causalQuestionId);
    if (question.status !== "AWAITING_CAUSAL_REVIEW") {
      throw new CausalError(
        "CAUSAL_STATE_CONFLICT",
        `routeReview requires AWAITING_CAUSAL_REVIEW`,
      );
    }
    const existing = await this.deps.reviewRequests.getPendingByQuestion(
      causalQuestionId,
    );
    if (existing) {
      const nonce = this.noncePlaintextByRequest.get(existing.reviewRequestId);
      if (!nonce) {
        throw new CausalError(
          "CAUSAL_REVIEW_INVALID",
          "Pending review exists but nonce unavailable in this process",
        );
      }
      return { request: existing, decisionNonce: nonce };
    }
    const claim = await this.deps.claims.getLatestByQuestion(causalQuestionId);
    const synthesis = await this.deps.syntheses.getLatestByQuestion(
      causalQuestionId,
    );
    const analysis = await this.deps.identifications.getLatestByQuestion(
      causalQuestionId,
    );
    const graph = await this.deps.graphs.getLatestByQuestion(causalQuestionId);
    if (!claim || !synthesis || !analysis || !graph) {
      throw new CausalError(
        "CAUSAL_REVIEW_INVALID",
        "Missing claim/synthesis/analysis/graph for review routing",
      );
    }
    const resolved = await this.deps.controlPlane.resolve(
      question.projectIds[0]!,
      question.targetEnvironment,
    );
    const policyBundleFingerprint = resolved.activePolicyBundle.policyHash;
    const capabilitySetFingerprintValue = capabilitySetFingerprint(
      resolved.availableCapabilities,
    );
    const createdAt = this.deps.nowIso();
    const expiresAt = new Date(
      Date.parse(createdAt) + this.reviewWindowMs,
    ).toISOString();
    const subjectHash = computeCausalReviewSubjectHash({
      causalQuestionId,
      causalQuestionVersion: question.causalQuestionVersion,
      claimId: claim.claimId,
      claimVersion: claim.claimVersion,
      claimHash: claim.claimHash,
      graphHash: graph.graphHash,
      identificationAnalysisId: analysis.identificationAnalysisId,
      evidenceSynthesisHash: synthesis.synthesisHash,
      populationScope: claim.populationScope,
      environmentScope: claim.environmentScope,
      policyBundleFingerprint,
      capabilitySetFingerprint: capabilitySetFingerprintValue,
      expiresAt,
    });
    if (!this.deps.nonceGenerator) {
      throw new CausalError(
        "CAUSAL_REVIEW_INVALID",
        "Nonce generator not configured",
      );
    }
    const issued = issueDecisionNonce(this.deps.nonceGenerator);
    const request: CausalReviewRequest = {
      reviewRequestId: mintCausalReviewRequestId({
        causalQuestionId,
        claimHash: claim.claimHash,
      }),
      causalQuestionId,
      causalQuestionVersion: question.causalQuestionVersion,
      claimId: claim.claimId,
      claimVersion: claim.claimVersion,
      claimHash: claim.claimHash,
      graphHash: graph.graphHash,
      identificationAnalysisId: analysis.identificationAnalysisId,
      evidenceSynthesisHash: synthesis.synthesisHash,
      evidenceRefs: claim.evidenceRefs,
      populationScope: claim.populationScope,
      environmentScope: claim.environmentScope,
      policyBundleFingerprint,
      capabilitySetFingerprint: capabilitySetFingerprintValue,
      subjectHash,
      decisionNonceHash: issued.nonceHash,
      status: "PENDING",
      expiresAt,
      createdAt,
      recordRevision: 1,
    };
    await this.deps.reviewRequests.save(request);
    this.noncePlaintextByRequest.set(request.reviewRequestId, issued.plaintext);
    return { request, decisionNonce: issued.plaintext };
  }

  async decideReview(input: {
    reviewRequestId: string;
    reviewerId: string;
    decision: CausalReviewDecision;
    decisionNonce: string;
    submittedAt: string;
  }): Promise<{
    request: CausalReviewRequest;
    record?: CausalReviewRecord;
    question: CausalQuestion;
    promoted?: PromotedCausalClaim;
  }> {
    const request = await this.deps.reviewRequests.getById(
      input.reviewRequestId,
    );
    if (!request) {
      throw new CausalError(
        "CAUSAL_REVIEW_INVALID",
        `Unknown review request ${input.reviewRequestId}`,
      );
    }
    if (request.status !== "PENDING") {
      throw new CausalError(
        "CAUSAL_REVIEW_INVALID",
        `Review request not PENDING (${request.status})`,
      );
    }
    if (Date.parse(input.submittedAt) > Date.parse(request.expiresAt)) {
      throw new CausalError(
        "CAUSAL_REVIEW_EXPIRED",
        "Causal review request expired",
      );
    }
    if (hashDecisionNonce(input.decisionNonce) !== request.decisionNonceHash) {
      throw new CausalError(
        "CAUSAL_REVIEW_INVALID",
        "Decision nonce mismatch / replay",
      );
    }
    const question = await this.requireQuestion(request.causalQuestionId);
    if (!this.deps.isCausalReviewer) {
      throw new CausalError(
        "CAUSAL_REVIEWER_SCOPE_INSUFFICIENT",
        "CAUSAL_REVIEWER authority check not configured",
      );
    }
    const allowed = await this.deps.isCausalReviewer(
      input.reviewerId,
      question.projectIds,
    );
    if (!allowed) {
      throw new CausalError(
        "CAUSAL_REVIEWER_SCOPE_INSUFFICIENT",
        "Principal lacks CAUSAL_REVIEWER for all affected projects",
        { reviewerId: input.reviewerId, projectIds: question.projectIds },
      );
    }

    const decided: CausalReviewRequest = {
      ...request,
      status: "DECIDED",
      reviewerId: input.reviewerId,
      decision: input.decision,
      decidedAt: input.submittedAt,
      recordRevision: request.recordRevision,
    };
    await this.deps.reviewRequests.update(decided);
    this.noncePlaintextByRequest.delete(request.reviewRequestId);

    const record: CausalReviewRecord = {
      reviewRecordId: mintCausalReviewRecordId({
        reviewRequestId: request.reviewRequestId,
        decidedAt: input.submittedAt,
      }),
      reviewRequestId: request.reviewRequestId,
      causalQuestionId: request.causalQuestionId,
      claimId: request.claimId,
      claimVersion: request.claimVersion,
      claimHash: request.claimHash,
      reviewerId: input.reviewerId,
      decision: input.decision,
      subjectHash: request.subjectHash,
      decisionNonceHash: request.decisionNonceHash,
      decidedAt: input.submittedAt,
      expiresAt: request.expiresAt,
      createdAt: this.deps.nowIso(),
    };
    await this.deps.reviewRecords.save(record);

    if (input.decision === "REJECT") {
      const next = await this.transition(question, "REJECTED");
      return { request: decided, record, question: next };
    }
    if (input.decision === "REQUEST_REVISION") {
      const next = await this.transition(question, "GRAPH_PROPOSED");
      return { request: decided, record, question: next };
    }

    const reviewed = await this.transition(question, "REVIEWED");
    const claim = await this.deps.claims.getById(request.claimId);
    const synthesis = await this.deps.syntheses.getLatestByQuestion(
      request.causalQuestionId,
    );
    if (!claim || !synthesis) {
      throw new CausalError(
        "CAUSAL_PROMOTION_REJECTED",
        "Claim or synthesis missing for promotion",
      );
    }
    if (claim.claimHash !== request.claimHash) {
      throw new CausalError(
        "CAUSAL_PROMOTION_REJECTED",
        "Claim hash does not match review request binding",
        {
          claimId: request.claimId,
          claimHash: claim.claimHash,
          requestClaimHash: request.claimHash,
        },
      );
    }
    // Do NOT mutate claim fields — promotion binds the reviewed claim as-is.
    assertPromotionCompatibleWithSynthesis({
      synthesisStatus: synthesis.synthesisStatus,
      claimType: claim.claimType,
    });

    const promotionBasisHash = computePromotionBasisHash({
      claimId: claim.claimId,
      claimVersion: claim.claimVersion,
      claimHash: claim.claimHash,
      claimType: claim.claimType,
      reviewRecordId: record.reviewRecordId,
      identificationAnalysisId: request.identificationAnalysisId,
      evidenceSynthesisId: synthesis.evidenceSynthesisId,
      evidenceSynthesisHash: synthesis.synthesisHash,
      synthesisStatus: synthesis.synthesisStatus,
      evidenceHashes: claim.evidenceRefs,
      contradictoryEvidenceRefs: claim.contradictoryEvidenceRefs,
      populationScope: claim.populationScope,
      environmentScope: claim.environmentScope,
    });
    const promoted: PromotedCausalClaim = {
      promotedCausalClaimId: mintPromotedCausalClaimId({
        claimHash: claim.claimHash,
        reviewRecordId: record.reviewRecordId,
      }),
      claimId: claim.claimId,
      claimVersion: claim.claimVersion,
      claimHash: claim.claimHash,
      claimType: claim.claimType,
      causalQuestionId: claim.causalQuestionId,
      causalQuestionVersion: claim.causalQuestionVersion,
      reviewRecordId: record.reviewRecordId,
      identificationAnalysisId: request.identificationAnalysisId,
      evidenceSynthesisId: synthesis.evidenceSynthesisId,
      evidenceSynthesisHash: synthesis.synthesisHash,
      synthesisStatus: synthesis.synthesisStatus,
      evidenceHashes: claim.evidenceRefs,
      populationScope: claim.populationScope,
      environmentScope: claim.environmentScope,
      limitations: claim.limitations,
      contradictoryEvidenceRefs: claim.contradictoryEvidenceRefs,
      promotionBasisHash,
      status: "ACTIVE",
      promotedAt: this.deps.nowIso(),
      promotedBy: input.reviewerId,
    };
    await this.deps.promotedClaims.save(promoted);
    const next = await this.transition(reviewed, "PROMOTED");
    return {
      request: decided,
      record,
      question: next,
      promoted,
    };
  }

  async createCalibrationCandidate(input: {
    promotedCausalClaimId: string;
    affectedModelComponent?: string;
  }): Promise<DecisionModelCalibrationCandidate> {
    const promoted = await this.deps.promotedClaims.getById(
      input.promotedCausalClaimId,
    );
    if (!promoted) {
      throw new CausalError(
        "CAUSAL_PROMOTION_REJECTED",
        `Promoted claim ${input.promotedCausalClaimId} not found`,
      );
    }
    if (promoted.status === "STALE") {
      throw new CausalError(
        "CAUSAL_CLAIM_STALE",
        "Cannot create calibration candidate from STALE promoted claim",
        { promotedCausalClaimId: promoted.promotedCausalClaimId },
      );
    }
    if (promoted.status !== "ACTIVE") {
      throw new CausalError(
        "CAUSAL_PROMOTION_REJECTED",
        "Calibration candidate requires ACTIVE promoted causal claim",
        { status: promoted.status },
      );
    }
    const question = await this.requireQuestion(promoted.causalQuestionId);
    const claim = await this.deps.claims.getById(promoted.claimId);
    if (!claim) {
      throw new CausalError(
        "CAUSAL_PROMOTION_REJECTED",
        "Source claim missing for calibration candidate",
      );
    }
    const affectedModelComponent =
      input.affectedModelComponent ?? "scenario_assumption_effect_prior";
    const calibration = withCalibrationCandidateHash({
      candidateId: mintCalibrationCandidateId({
        promotedCausalClaimId: promoted.promotedCausalClaimId,
        affectedModelComponent,
      }),
      sourcePromotedCausalClaimIds: [promoted.promotedCausalClaimId],
      promotedCausalClaimId: promoted.promotedCausalClaimId,
      promotedClaimHash: promoted.claimHash,
      reviewRecordId: promoted.reviewRecordId,
      sourceClaimHash: promoted.claimHash,
      identificationAnalysisId: promoted.identificationAnalysisId,
      evidenceSynthesisHash: promoted.evidenceSynthesisHash,
      sourceExperimentIds: question.sourceExperimentIds,
      affectedModelComponent,
      currentValueOrRelationship: "uninformed_or_prior",
      proposedValueOrRelationship: `consider_effect_${claim.effectEstimate ?? "unknown"}_${claim.unit ?? "na"}`,
      evidenceRefs: claim.evidenceRefs,
      scope: `${promoted.populationScope}/${promoted.environmentScope}`,
      populationScope: promoted.populationScope,
      environmentScope: promoted.environmentScope,
      expectedImpact: claim.claimType,
      limitations: [
        "CALIBRATION CANDIDATE != MODEL CHANGE",
        "Requires Phase 16 re-analysis — never mutates AssumptionSets in place",
      ],
      requiresPhase16Reanalysis: true,
      createdAt: this.deps.nowIso(),
    });
    await this.deps.calibrationCandidates.save(calibration);
    return calibration;
  }

  async markPromotedClaimStale(input: {
    promotedCausalClaimId: string;
    reason: string;
  }): Promise<PromotedCausalClaim> {
    return this.deps.promotedClaims.markStale(
      input.promotedCausalClaimId,
      input.reason,
    );
  }

  getDeliveredReviewNonce(reviewRequestId: string): string | undefined {
    return this.noncePlaintextByRequest.get(reviewRequestId);
  }

  /**
   * Resolve authoritative randomized evidence for the question's primary
   * source experiment. Requires authoritativeExperimentEvidence + sourceExperimentIds[0].
   */
  private async resolveAuthoritativeRandomized(
    question: CausalQuestion,
  ): Promise<ResolvedRandomizedEvidence> {
    if (!this.deps.authoritativeExperimentEvidence) {
      throw new CausalError(
        "CAUSAL_EVIDENCE_INVALID",
        "Authoritative experiment evidence port not configured",
      );
    }
    const experimentId = question.sourceExperimentIds[0];
    if (!experimentId) {
      throw new CausalError(
        "CAUSAL_EVIDENCE_INVALID",
        "RANDOMIZED_TREATMENT estimation requires sourceExperimentIds[0]",
      );
    }
    const expectedExperimentPlanHash =
      expectedPlanHashFromConstraints(question.constraints);
    return this.deps.authoritativeExperimentEvidence.resolveForEstimation({
      experimentId,
      expectedProjectIds: question.projectIds,
      expectedEnvironment: question.targetEnvironment,
      expectedOutcomeUnit: question.outcomeUnit,
      ...(expectedExperimentPlanHash
        ? { expectedExperimentPlanHash }
        : {}),
    });
  }

  private async tryResolveAuthoritativeForIdentification(
    question: CausalQuestion,
  ): Promise<ResolvedRandomizedEvidence[] | null> {
    if (
      !this.deps.authoritativeExperimentEvidence ||
      question.sourceExperimentIds.length === 0
    ) {
      return null;
    }
    const expectedExperimentPlanHash =
      expectedPlanHashFromConstraints(question.constraints);
    const resolved: ResolvedRandomizedEvidence[] = [];
    try {
      for (const experimentId of question.sourceExperimentIds) {
        const item =
          await this.deps.authoritativeExperimentEvidence.resolveForEstimation({
            experimentId,
            expectedProjectIds: question.projectIds,
            expectedEnvironment: question.targetEnvironment,
            expectedOutcomeUnit: question.outcomeUnit,
            ...(expectedExperimentPlanHash
              ? { expectedExperimentPlanHash }
              : {}),
          });
        if (item.experimentId !== experimentId) {
          throw new CausalError(
            "CAUSAL_EVIDENCE_INVALID",
            "Cross-experiment evidence substitution rejected",
          );
        }
        resolved.push(item);
      }
      return resolved;
    } catch {
      return null;
    }
  }

  private async persistAuthoritativeEvidenceRefs(
    question: CausalQuestion,
    resolvedList: readonly ResolvedRandomizedEvidence[],
  ): Promise<CausalEvidenceReference[]> {
    const refs: CausalEvidenceReference[] = [];
    for (const resolved of resolvedList) {
      const ref: CausalEvidenceReference = {
        evidenceRefId: mintEvidenceRefId({
          sourceClass: "EXPERIMENT_EVIDENCE_BUNDLE",
          sourceId: resolved.evidenceBundleId,
          evidenceHash: resolved.evidenceBundleHash,
        }),
        sourceClass: "EXPERIMENT_EVIDENCE_BUNDLE",
        sourceId: resolved.evidenceBundleId,
        sourceVersion: String(resolved.experimentVersion),
        evidenceHash: resolved.evidenceBundleHash,
        projectId: resolved.projectId,
        populationScope: resolved.populationScope,
        environmentScope: resolved.environmentScope,
        timeRange: "experiment",
        quality: resolved.quality,
        evidenceDesign: "RANDOMIZED_EXPERIMENT",
        verificationRefs: [...resolved.verificationRefs],
        treatmentMean: resolved.treatmentMean,
        controlMean: resolved.controlMean,
        treatmentSampleCount: resolved.treatmentSampleCount,
        controlSampleCount: resolved.controlSampleCount,
        outcomeUnit: resolved.outcomeUnit,
        assignmentMethod: resolved.assignmentMethod,
        assignmentProvenance: resolved.assignmentProvenance,
        createdAt: this.deps.nowIso(),
      };
      await this.deps.evidenceRefs.save(ref);
      this.deps.evidenceRefs.bindQuestion?.(
        question.causalQuestionId,
        ref.evidenceRefId,
      );
      refs.push(ref);
    }
    return refs;
  }

  private buildRandomizedAnalysis(
    question: CausalQuestion,
    graph: CausalGraph,
    evidenceRefs: CausalEvidenceReference[],
    resolved: readonly ResolvedRandomizedEvidence[],
  ): CausalIdentificationAnalysis {
    const evidenceRefIds = evidenceRefs.map((e) => e.evidenceRefId);
    const assumptions: IdentificationAssumption[] = [
      {
        assumptionId: "asm_randomization_integrity",
        statement: "Randomized assignment integrity with provenance",
        status: "SUPPORTED",
        evidenceRefs: evidenceRefIds,
        riskIfViolated: "HIGH",
        testability: "PARTIALLY_TESTABLE",
        materiality: "HIGH",
      },
      {
        assumptionId: "asm_measurement_consistency",
        statement: "Treatment/control measured with consistent outcome unit",
        status: "SUPPORTED",
        evidenceRefs: evidenceRefIds,
        riskIfViolated: "HIGH",
        testability: "TESTABLE",
        materiality: "HIGH",
      },
      {
        assumptionId: "asm_no_unauthorized_reassignment",
        statement: "No unauthorized reassignment after randomization",
        status: "PLAUSIBLE",
        evidenceRefs: evidenceRefIds,
        riskIfViolated: "HIGH",
        testability: "PARTIALLY_TESTABLE",
        materiality: "HIGH",
      },
    ];
    void resolved;
    return this.buildAnalysis({
      question,
      graph,
      strategy: "RANDOMIZED_TREATMENT",
      status: "IDENTIFIED",
      assumptions,
      evidenceRefIds,
      limitations: [
        "PLAUSIBLE assumptions are not TRUE",
        "Identification scoped to evidence population/environment",
        "CALLER-SUPPLIED SAMPLE VALUES != CAUSAL ESTIMATION AUTHORITY",
      ],
    });
  }

  private tryBackdoorIdentification(
    question: CausalQuestion,
    graph: CausalGraph,
    evidence: CausalEvidenceReference[],
  ): CausalIdentificationAnalysis | null {
    // Structural backdoor requires an explicit adjustment set proven against DAG.
    // Without implemented d-separation prover over measured confounders → NOT_IDENTIFIED.
    void question;
    void graph;
    void evidence;
    return null;
  }

  private notIdentified(
    question: CausalQuestion,
    graph: CausalGraph,
    evidence: CausalEvidenceReference[],
  ): CausalIdentificationAnalysis {
    return this.buildAnalysis({
      question,
      graph,
      strategy: "UNIDENTIFIED",
      status: "NOT_IDENTIFIED",
      assumptions: [
        {
          assumptionId: "asm_no_unmeasured_confounding",
          statement: "No unmeasured confounding",
          status: "UNVERIFIED",
          evidenceRefs: evidence.map((e) => e.evidenceRefId),
          riskIfViolated: "HIGH",
          testability: "UNTESTABLE",
          materiality: "HIGH",
        },
      ],
      evidenceRefIds: evidence.map((e) => e.evidenceRefId),
      limitations: [
        "Association alone never yields IDENTIFIED",
        "BACKDOOR_ADJUSTMENT refused without structural proof",
        "Fabricated attachEvidence samples are not randomization authority",
      ],
    });
  }

  private buildAnalysis(input: {
    question: CausalQuestion;
    graph: CausalGraph;
    strategy: IdentificationStrategy;
    status: IdentificationStatus;
    assumptions: IdentificationAssumption[];
    evidenceRefIds: string[];
    limitations: string[];
    adjustmentSet?: string[];
    adjustmentJustification?: string;
  }): CausalIdentificationAnalysis {
    const fingerprint = computeIdentificationFingerprint({
      causalQuestionId: input.question.causalQuestionId,
      causalQuestionVersion: input.question.causalQuestionVersion,
      graphHash: input.graph.graphHash,
      intervention: input.question.intervention,
      outcome: input.question.outcome,
      adjustmentSet: input.adjustmentSet ?? [],
      strategy: input.strategy,
      assumptions: input.assumptions,
      evidenceIdentities: input.evidenceRefIds,
      population: input.question.targetPopulation,
      environment: input.question.targetEnvironment,
      estimatorVersion: "difference_in_means_v1",
    });
    return {
      identificationAnalysisId: mintIdentificationAnalysisId({
        causalQuestionId: input.question.causalQuestionId,
        fingerprint,
      }),
      causalQuestionId: input.question.causalQuestionId,
      causalQuestionVersion: input.question.causalQuestionVersion,
      causalGraphId: input.graph.causalGraphId,
      causalGraphVersion: input.graph.causalGraphVersion,
      graphHash: input.graph.graphHash,
      strategy: input.strategy,
      status: input.status,
      adjustmentSet: input.adjustmentSet ?? [],
      ...(input.adjustmentJustification
        ? { adjustmentJustification: input.adjustmentJustification }
        : {}),
      assumptions: input.assumptions,
      evidenceRefIds: input.evidenceRefIds,
      estimatorVersion: "difference_in_means_v1",
      populationScope: input.question.targetPopulation,
      environmentScope: input.question.targetEnvironment,
      identificationFingerprint: fingerprint,
      limitations: input.limitations,
      createdAt: this.deps.nowIso(),
    };
  }

  private async requireQuestion(id: string): Promise<CausalQuestion> {
    const q = await this.deps.questions.getById(id);
    if (!q) {
      throw new CausalError(
        "CAUSAL_QUESTION_NOT_FOUND",
        `Unknown causal question ${id}`,
      );
    }
    return q;
  }

  private async transition(
    question: CausalQuestion,
    next: CausalQuestion["status"],
    patch: Partial<CausalQuestion> = {},
  ): Promise<CausalQuestion> {
    assertCausalQuestionTransition(question.status, next);
    return withOptionalTransaction(this.deps.transactions, async () =>
      this.deps.questions.transition(
        question.causalQuestionId,
        question.status,
        question.recordRevision,
        next,
        this.deps.nowIso(),
        patch,
      ),
    );
  }
}

function expectedPlanHashFromConstraints(
  constraints: readonly string[],
): string | undefined {
  for (const c of constraints) {
    if (c.startsWith("experimentPlanHash=")) {
      return c.slice("experimentPlanHash=".length);
    }
  }
  return undefined;
}
