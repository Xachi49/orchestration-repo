import { createHash } from "node:crypto";
import type { ControlPlaneService } from "../control-plane/service.js";
import {
  issueDecisionNonce,
  type DecisionNonceGenerator,
  SequenceDecisionNonceGenerator,
} from "../authorization/decision-nonce.js";
import { hashDecisionNonce } from "../authorization/decision-card-hasher.js";
import { DecisionPolicyError } from "./errors.js";
import {
  computeDecisionContextHash,
  mintDecisionContextId,
  parseDecisionContext,
  type DecisionContext,
} from "./context.js";
import {
  defaultNoActionDefinition,
  DecisionActionDefinitionSchema,
  type DecisionActionDefinition,
  type DecisionStateVariable,
} from "./variables-actions.js";
import {
  INITIAL_DECISION_POLICY_VERSION,
  mintDecisionPolicyId,
  withDecisionPolicyHash,
  type DecisionPolicyCandidate,
} from "./policy.js";
import { assertDecisionPolicyTransition } from "./context.js";
import { validateDecisionPolicy, assertValidationPass } from "./validation.js";
import {
  evaluateDecisionPolicyOffline,
  type HistoricalDecisionCase,
  type DecisionPolicyEvaluation,
} from "./evaluation.js";
import {
  compareChampionChallenger,
  type DecisionPolicyComparison,
} from "./comparison.js";
import {
  computeActivationHash,
  computeActivationSubjectHash,
  computeDecisionPolicyApprovalSubjectHash,
  mintActivationRecordId,
  mintActivationRequestId,
  mintDecisionPolicyApprovalRecordId,
  mintDecisionPolicyApprovalRequestId,
  type DecisionPolicyActivationRecord,
  type DecisionPolicyApprovalDecision,
  type DecisionPolicyActivationDecision,
  type DecisionPolicyApprovalRequest,
  type DecisionPolicyActivationRequest,
} from "./authority.js";
import { type DecisionStateSnapshot } from "./snapshot.js";
import { selectActionForState } from "./evaluation.js";
import {
  aggregateShadowEvaluation,
  assessPolicyConcentration,
  computeRecommendationIdentity,
  mintDecisionRecommendationId,
  mintRevisionCandidate,
  mintShadowRecordId,
  type DecisionOverrideRecord,
  type DecisionPolicyRevisionCandidate,
  type DecisionPolicyShadowEvaluation,
  type DecisionRecommendation,
  type ShadowDecisionRecord,
} from "./shadow-recommendation.js";
import {
  DecisionRecommendationCompiler,
  computeLineageHash,
  mintMaterializationLineageId,
  type DecisionRecommendationCompilerDeps,
  type DecisionRecommendationMaterializationLineage,
  type DecisionRecommendationMaterializationLineageRepository,
  type MaterializationResult,
} from "./compiler.js";
import type { DecisionPolicySynthesisModel } from "./synthesis-model.js";
import {
  DecisionStateResolutionService,
  type DecisionStateSourcePort,
} from "./state-resolution.js";
import {
  assessCausalScopeCompatibility,
  assertCausalEvidenceUsableForAuthority,
  bindCausalEvidence,
  type CausalEvidenceBinding,
  type CausalGovernedEvidencePort,
} from "./causal-evidence.js";
import {
  assessDecisionPolicyActivationReadiness,
  assertActivationReady,
  causalBindingsStillMatch,
} from "./activation-readiness.js";
import type { DecisionStateValues } from "./predicates.js";
import type {
  DecisionContextRepository,
  DecisionOverrideRecordRepository,
  DecisionPolicyActivationRecordRepository,
  DecisionPolicyActivationRequestRepository,
  DecisionPolicyApprovalRecordRepository,
  DecisionPolicyApprovalRequestRepository,
  DecisionPolicyCandidateRepository,
  DecisionPolicyComparisonRepository,
  DecisionPolicyEvaluationRepository,
  DecisionPolicyPerformanceRecordRepository,
  DecisionPolicyRevisionCandidateRepository,
  DecisionPolicyShadowEvaluationRepository,
  DecisionPolicyShadowRecordRepository,
  DecisionRecommendationRepository,
  DecisionStateSnapshotRepository,
} from "./repositories.js";

export interface DecisionPolicyOrchestrationDeps {
  nowIso: () => string;
  contexts: DecisionContextRepository;
  policies: DecisionPolicyCandidateRepository;
  evaluations: DecisionPolicyEvaluationRepository;
  comparisons: DecisionPolicyComparisonRepository;
  approvalRequests: DecisionPolicyApprovalRequestRepository;
  approvalRecords: DecisionPolicyApprovalRecordRepository;
  shadowRecords: DecisionPolicyShadowRecordRepository;
  shadowEvaluations: DecisionPolicyShadowEvaluationRepository;
  activationRequests: DecisionPolicyActivationRequestRepository;
  activationRecords: DecisionPolicyActivationRecordRepository;
  snapshots: DecisionStateSnapshotRepository;
  recommendations: DecisionRecommendationRepository;
  overrides: DecisionOverrideRecordRepository;
  performance: DecisionPolicyPerformanceRecordRepository;
  revisions: DecisionPolicyRevisionCandidateRepository;
  controlPlane: ControlPlaneService;
  synthesisModel: DecisionPolicySynthesisModel;
  isDecisionPolicyApprover?: (
    principalId: string,
    projectIds: readonly string[],
  ) => Promise<boolean>;
  isDecisionPolicyActivator?: (
    principalId: string,
    projectIds: readonly string[],
  ) => Promise<boolean>;
  nonceGenerator?: DecisionNonceGenerator;
  approvalWindowMs?: number;
  activationWindowMs?: number;
  /** Required for live recommend/shadow — authoritative source resolution. */
  decisionStateSource?: DecisionStateSourcePort;
  causalEvidence?: CausalGovernedEvidencePort;
  compilerDeps?: DecisionRecommendationCompilerDeps;
  materializationLineages?: DecisionRecommendationMaterializationLineageRepository;
}

export interface AdmitDecisionContextInput {
  projectIds: string[];
  environmentScope: string[];
  stateVariables: DecisionStateVariable[];
  eligibleActions?: DecisionActionDefinition[];
  constraints?: string[];
  nonGoals?: string[];
  optimizationObjectives: DecisionContext["optimizationObjectives"];
  riskTolerance: DecisionContext["riskTolerance"];
  materialityThreshold: number;
  timeHorizon: string;
  createdBy: string;
  strategicGoalRefs?: string[];
  portfolioRefs?: string[];
  programRefs?: string[];
  decisionProblemRefs?: string[];
}

const DEFAULT_APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ACTIVATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export class DecisionPolicyOrchestrationService {
  private readonly nonceGenerator: DecisionNonceGenerator;
  private readonly compiler: DecisionRecommendationCompiler;
  private readonly stateResolver: DecisionStateResolutionService | undefined;

  constructor(private readonly deps: DecisionPolicyOrchestrationDeps) {
    this.nonceGenerator =
      deps.nonceGenerator ?? new SequenceDecisionNonceGenerator();
    this.compiler = new DecisionRecommendationCompiler(
      deps.compilerDeps ?? { allowMaterialization: false },
    );
    this.stateResolver = deps.decisionStateSource
      ? new DecisionStateResolutionService({
          source: deps.decisionStateSource,
          nowIso: deps.nowIso,
        })
      : undefined;
  }

  async admitContext(
    input: AdmitDecisionContextInput,
  ): Promise<{ context: DecisionContext }> {
    const now = this.deps.nowIso();
    for (const projectId of input.projectIds) {
      for (const env of input.environmentScope) {
        await this.deps.controlPlane.resolve(projectId, env);
      }
    }
    const eligibleActions =
      input.eligibleActions && input.eligibleActions.length > 0
        ? input.eligibleActions.map((a) =>
            DecisionActionDefinitionSchema.parse(a),
          )
        : [
            defaultNoActionDefinition({
              projectIds: input.projectIds,
              environments: input.environmentScope,
            }),
          ];
    if (!eligibleActions.some((a) => a.actionClass === "NO_ACTION")) {
      eligibleActions.push(
        defaultNoActionDefinition({
          projectIds: input.projectIds,
          environments: input.environmentScope,
        }),
      );
    }
    const decisionContextId = mintDecisionContextId({
      projectIds: input.projectIds,
      createdAt: now,
    });
    const base = {
      decisionContextId,
      decisionContextVersion: 1,
      projectIds: input.projectIds,
      environmentScope: input.environmentScope,
      strategicGoalRefs: input.strategicGoalRefs ?? [],
      portfolioRefs: input.portfolioRefs ?? [],
      programRefs: input.programRefs ?? [],
      decisionProblemRefs: input.decisionProblemRefs ?? [],
      stateVariables: input.stateVariables,
      eligibleActions,
      constraints: input.constraints ?? [],
      nonGoals: input.nonGoals ?? [],
      optimizationObjectives: input.optimizationObjectives,
      riskTolerance: input.riskTolerance,
      materialityThreshold: input.materialityThreshold,
      timeHorizon: input.timeHorizon,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      status: "ADMITTED" as const,
      recordRevision: 1,
    };
    const contextHash = computeDecisionContextHash(base);
    const context = parseDecisionContext({ ...base, contextHash });
    await this.deps.contexts.save(context);
    return { context };
  }

  async synthesizePolicy(input: {
    decisionContextId: string;
    createdBy: string;
    sourcePromotedCausalClaimIds?: string[];
    sourceEvidenceRefs?: string[];
    sourceScenarioRefs?: string[];
  }): Promise<{ policy: DecisionPolicyCandidate }> {
    const context = await this.requireContext(input.decisionContextId);
    const causalBindings = await this.resolveCausalBindings(
      context,
      input.sourcePromotedCausalClaimIds ?? [],
      { allowPartial: false },
    );
    const proposal = await this.deps.synthesisModel.synthesize({
      context,
      ...(input.sourcePromotedCausalClaimIds !== undefined
        ? { sourcePromotedCausalClaimIds: input.sourcePromotedCausalClaimIds }
        : {}),
    });
    const now = this.deps.nowIso();
    const fingerprints = await this.governanceFingerprints(context);
    const policy = withDecisionPolicyHash({
      decisionPolicyId: mintDecisionPolicyId({
        decisionContextId: context.decisionContextId,
        createdAt: now,
      }),
      decisionPolicyVersion: INITIAL_DECISION_POLICY_VERSION,
      decisionContextId: context.decisionContextId,
      decisionContextVersion: context.decisionContextVersion,
      decisionContextHash: context.contextHash,
      rules: proposal.rules,
      defaultActionId: proposal.defaultActionId,
      sourceEvidenceRefs: input.sourceEvidenceRefs ?? [],
      sourcePromotedCausalClaimIds: input.sourcePromotedCausalClaimIds ?? [],
      sourceScenarioRefs: input.sourceScenarioRefs ?? [],
      sourceScenarioHashes: [],
      sourceCausalBindings: causalBindings,
      objectiveWeights: proposal.objectiveWeights,
      riskConstraints: {
        maxRiskClass: context.riskTolerance,
        maxUnsupportedStateRate: 0.5,
        maxConstraintViolations: 0,
        maxStaleSourceRate: 0.1,
      },
      evaluationRequirements: {
        requireOfflineEvaluation: true,
        requireShadowEvidence: true,
        minimumShadowRecords: 1,
        minimumCoverage: 0,
        minimumEvidenceQuality: "PARTIAL",
      },
      synthesisModelId: this.deps.synthesisModel.modelId,
      synthesisModelVersion: this.deps.synthesisModel.modelVersion,
      status: "SYNTHESIZED",
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy,
      recordRevision: 1,
      governancePolicyFingerprint: fingerprints.policy,
      capabilitySetFingerprint: fingerprints.capabilities,
    });
    await this.deps.policies.save(policy);
    return { policy };
  }

  async validatePolicy(decisionPolicyId: string): Promise<{
    policy: DecisionPolicyCandidate;
    validation: ReturnType<typeof validateDecisionPolicy>;
  }> {
    const policy = await this.requirePolicy(decisionPolicyId);
    const context = await this.requireContext(policy.decisionContextId);
    await this.assertCausalBindingsLive(policy, context);
    const validation = validateDecisionPolicy({ context, policy });
    if (validation.outcome === "BLOCK" || validation.outcome === "REVISE") {
      assertValidationPass(validation);
    }
    const next = await this.transition(policy, "VALIDATED");
    return { policy: next, validation };
  }

  async evaluateOffline(
    decisionPolicyId: string,
    cases: readonly HistoricalDecisionCase[],
  ): Promise<{
    policy: DecisionPolicyCandidate;
    evaluation: DecisionPolicyEvaluation;
  }> {
    const policy = await this.requirePolicy(decisionPolicyId);
    if (policy.status !== "VALIDATED" && policy.status !== "AWAITING_APPROVAL") {
      throw new DecisionPolicyError(
        "DECISION_POLICY_STATE_CONFLICT",
        `evaluateOffline requires VALIDATED or AWAITING_APPROVAL (got ${policy.status})`,
      );
    }
    const context = await this.requireContext(policy.decisionContextId);
    await this.assertCausalBindingsLive(policy, context);
    const evaluation = evaluateDecisionPolicyOffline({
      policy,
      context,
      cases,
      nowIso: this.deps.nowIso(),
    });
    await this.deps.evaluations.save(evaluation);
    return { policy, evaluation };
  }

  async comparePolicies(input: {
    championPolicyId: string;
    challengerPolicyId: string;
  }): Promise<{ comparison: DecisionPolicyComparison }> {
    const champion = await this.requirePolicy(input.championPolicyId);
    const challenger = await this.requirePolicy(input.challengerPolicyId);
    const champEval = await this.deps.evaluations.getLatestByPolicy(
      champion.decisionPolicyId,
    );
    const challEval = await this.deps.evaluations.getLatestByPolicy(
      challenger.decisionPolicyId,
    );
    if (!champEval || !challEval) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_VALIDATION_FAILED",
        "Both policies require offline evaluations before comparison",
      );
    }
    const comparison = compareChampionChallenger({
      champion: {
        policyId: champion.decisionPolicyId,
        version: champion.decisionPolicyVersion,
        policyHash: champion.policyHash,
        evaluation: champEval,
      },
      challenger: {
        policyId: challenger.decisionPolicyId,
        version: challenger.decisionPolicyVersion,
        policyHash: challenger.policyHash,
        evaluation: challEval,
      },
      nowIso: this.deps.nowIso(),
    });
    await this.deps.comparisons.save(comparison);
    return { comparison };
  }

  async routeApproval(decisionPolicyId: string): Promise<{
    policy: DecisionPolicyCandidate;
    request: DecisionPolicyApprovalRequest;
    decisionNonce: string;
  }> {
    const policy = await this.requirePolicy(decisionPolicyId);
    if (policy.status !== "VALIDATED") {
      throw new DecisionPolicyError(
        "DECISION_POLICY_STATE_CONFLICT",
        `routeApproval requires VALIDATED (got ${policy.status})`,
      );
    }
    const evaluation = await this.deps.evaluations.getLatestByPolicy(
      decisionPolicyId,
    );
    if (!evaluation) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_VALIDATION_FAILED",
        "Offline evaluation required before approval routing",
      );
    }
    const context = await this.requireContext(policy.decisionContextId);
    const fingerprints = await this.governanceFingerprints(context);
    this.assertGovernanceUnchanged(policy, fingerprints);

    const now = this.deps.nowIso();
    const expiresAt = new Date(
      Date.parse(now) +
        (this.deps.approvalWindowMs ?? DEFAULT_APPROVAL_WINDOW_MS),
    ).toISOString();
    const nonce = issueDecisionNonce(this.nonceGenerator);
    const subjectHash = computeDecisionPolicyApprovalSubjectHash({
      decisionPolicyId: policy.decisionPolicyId,
      decisionPolicyVersion: policy.decisionPolicyVersion,
      policyHash: policy.policyHash,
      decisionContextId: context.decisionContextId,
      decisionContextVersion: context.decisionContextVersion,
      decisionContextHash: context.contextHash,
      evaluationId: evaluation.decisionPolicyEvaluationId,
      evaluationHash: evaluation.evaluationHash,
      governancePolicyFingerprint: fingerprints.policy,
      capabilitySetFingerprint: fingerprints.capabilities,
      projectIds: context.projectIds,
      environmentScope: context.environmentScope,
      expiresAt,
    });
    const request = {
      decisionPolicyApprovalRequestId: mintDecisionPolicyApprovalRequestId({
        decisionPolicyId: policy.decisionPolicyId,
        policyHash: policy.policyHash,
      }),
      decisionPolicyId: policy.decisionPolicyId,
      decisionPolicyVersion: policy.decisionPolicyVersion,
      policyHash: policy.policyHash,
      decisionContextId: context.decisionContextId,
      decisionContextVersion: context.decisionContextVersion,
      decisionContextHash: context.contextHash,
      evaluationId: evaluation.decisionPolicyEvaluationId,
      evaluationHash: evaluation.evaluationHash,
      evidenceFingerprints: [
        ...policy.sourceEvidenceRefs,
        ...policy.sourcePromotedCausalClaimIds,
      ],
      governancePolicyFingerprint: fingerprints.policy,
      capabilitySetFingerprint: fingerprints.capabilities,
      projectIds: [...context.projectIds],
      environmentScope: [...context.environmentScope],
      subjectHash,
      decisionNonceHash: nonce.nonceHash,
      status: "PENDING" as const,
      expiresAt,
      createdAt: now,
      recordRevision: 1,
    };
    await this.deps.approvalRequests.save(request);
    const next = await this.transition(policy, "AWAITING_APPROVAL");
    return { policy: next, request, decisionNonce: nonce.plaintext };
  }

  async decideApproval(input: {
    decisionPolicyApprovalRequestId: string;
    approverId: string;
    decision: DecisionPolicyApprovalDecision;
    decisionNonce: string;
    submittedAt?: string;
  }): Promise<{
    policy: DecisionPolicyCandidate;
    record: {
      decisionPolicyApprovalRecordId: string;
      decisionPolicyApprovalRequestId: string;
      decisionPolicyId: string;
      decisionPolicyVersion: number;
      policyHash: string;
      approverId: string;
      decision: DecisionPolicyApprovalDecision;
      subjectHash: string;
      decisionNonceHash: string;
      decidedAt: string;
      expiresAt: string;
      createdAt: string;
    };
  }> {
    const request = await this.deps.approvalRequests.getById(
      input.decisionPolicyApprovalRequestId,
    );
    if (!request || request.status !== "PENDING") {
      throw new DecisionPolicyError(
        "DECISION_POLICY_APPROVAL_INVALID",
        "Approval request missing or not PENDING",
      );
    }
    const submittedAt = input.submittedAt ?? this.deps.nowIso();
    if (Date.parse(submittedAt) > Date.parse(request.expiresAt)) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_APPROVAL_EXPIRED",
        "Approval request expired",
      );
    }
    if (hashDecisionNonce(input.decisionNonce) !== request.decisionNonceHash) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_APPROVAL_INVALID",
        "Decision nonce mismatch / replay",
      );
    }
    if (!this.deps.isDecisionPolicyApprover) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_APPROVER_SCOPE_INSUFFICIENT",
        "Decision policy approver checker not configured",
      );
    }
    const allowed = await this.deps.isDecisionPolicyApprover(
      input.approverId,
      request.projectIds,
    );
    if (!allowed) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_APPROVER_SCOPE_INSUFFICIENT",
        "Principal is not DECISION_POLICY_APPROVER for all projects",
      );
    }
    const policy = await this.requirePolicy(request.decisionPolicyId);
    if (policy.policyHash !== request.policyHash) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_APPROVAL_INVALID",
        "Policy hash drift — approval cannot repoint",
      );
    }
    const record = await this.deps.approvalRecords.save({
      decisionPolicyApprovalRecordId: mintDecisionPolicyApprovalRecordId({
        decisionPolicyApprovalRequestId: request.decisionPolicyApprovalRequestId,
        decidedAt: submittedAt,
      }),
      decisionPolicyApprovalRequestId: request.decisionPolicyApprovalRequestId,
      decisionPolicyId: policy.decisionPolicyId,
      decisionPolicyVersion: policy.decisionPolicyVersion,
      policyHash: policy.policyHash,
      approverId: input.approverId,
      decision: input.decision,
      subjectHash: request.subjectHash,
      decisionNonceHash: request.decisionNonceHash,
      decidedAt: submittedAt,
      expiresAt: request.expiresAt,
      createdAt: submittedAt,
    });
    await this.deps.approvalRequests.save({
      ...request,
      status: "DECIDED",
      approverId: input.approverId,
      decision: input.decision,
      decidedAt: submittedAt,
      recordRevision: request.recordRevision + 1,
    });
    let next: DecisionPolicyCandidate;
    if (input.decision === "APPROVE_SHADOW") {
      next = await this.transition(policy, "APPROVED_FOR_SHADOW");
    } else if (input.decision === "REJECT") {
      next = await this.transition(policy, "REJECTED");
    } else {
      next = await this.transition(policy, "SYNTHESIZED");
    }
    return { policy: next, record };
  }

  async runShadowDecision(input: {
    decisionPolicyId: string;
    environment: string;
    hints?: DecisionStateValues;
    actualActionId?: string;
  }): Promise<{ policy: DecisionPolicyCandidate; record: ShadowDecisionRecord }> {
    let policy = await this.requirePolicy(input.decisionPolicyId);
    if (
      policy.status !== "APPROVED_FOR_SHADOW" &&
      policy.status !== "SHADOW_RUNNING"
    ) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_STATE_CONFLICT",
        `Shadow requires APPROVED_FOR_SHADOW or SHADOW_RUNNING (got ${policy.status})`,
      );
    }
    if (policy.status === "APPROVED_FOR_SHADOW") {
      policy = await this.transition(policy, "SHADOW_RUNNING");
    }
    const context = await this.requireContext(policy.decisionContextId);
    await this.assertCausalBindingsLive(policy, context);
    const snapshot = await this.resolveAuthoritativeSnapshot({
      context,
      environment: input.environment,
      ...(input.hints !== undefined ? { hints: input.hints } : {}),
    });
    await this.deps.snapshots.save(snapshot);
    const selected = selectActionForState({
      policy,
      context,
      stateValues: snapshot.values,
    });
    const record: ShadowDecisionRecord = {
      shadowDecisionRecordId: mintShadowRecordId({
        policyHash: policy.policyHash,
        contextSnapshotHash: snapshot.snapshotHash,
      }),
      decisionPolicyId: policy.decisionPolicyId,
      decisionPolicyVersion: policy.decisionPolicyVersion,
      policyHash: policy.policyHash,
      contextSnapshotHash: snapshot.snapshotHash,
      matchedRuleId: selected.matchedRuleId,
      recommendedActionId: selected.actionId,
      ...(input.actualActionId
        ? { actualActionId: input.actualActionId }
        : {}),
      actualVerifiedOutcomeRefs: [],
      counterfactualSupportStatus: "COUNTERFACTUAL_UNSUPPORTED",
      timestamp: this.deps.nowIso(),
      limitations: [
        "SHADOW_MODE != LIVE_AUTHORITY",
        "Shadow creates zero Objectives / Programs / Portfolio proposals / Experiments / execution attempts",
        ...(selected.unsupported ? ["unsupported state → default action"] : []),
      ],
    };
    await this.deps.shadowRecords.save(record);
    return { policy, record };
  }

  async evaluateShadow(decisionPolicyId: string): Promise<{
    policy: DecisionPolicyCandidate;
    evaluation: DecisionPolicyShadowEvaluation;
  }> {
    const policy = await this.requirePolicy(decisionPolicyId);
    if (policy.status !== "SHADOW_RUNNING") {
      throw new DecisionPolicyError(
        "DECISION_POLICY_STATE_CONFLICT",
        `evaluateShadow requires SHADOW_RUNNING (got ${policy.status})`,
      );
    }
    const records = await this.deps.shadowRecords.listByPolicy(decisionPolicyId);
    const evaluation = aggregateShadowEvaluation({
      decisionPolicyId: policy.decisionPolicyId,
      decisionPolicyVersion: policy.decisionPolicyVersion,
      policyHash: policy.policyHash,
      records,
      nowIso: this.deps.nowIso(),
    });
    await this.deps.shadowEvaluations.save(evaluation);
    const next = await this.transition(policy, "AWAITING_ACTIVATION");
    return { policy: next, evaluation };
  }

  async routeActivation(decisionPolicyId: string): Promise<{
    policy: DecisionPolicyCandidate;
    request: DecisionPolicyActivationRequest;
    decisionNonce: string;
  }> {
    const policy = await this.requirePolicy(decisionPolicyId);
    if (policy.status !== "AWAITING_ACTIVATION") {
      throw new DecisionPolicyError(
        "DECISION_POLICY_STATE_CONFLICT",
        `routeActivation requires AWAITING_ACTIVATION (got ${policy.status})`,
      );
    }
    const shadowEval = await this.deps.shadowEvaluations.getLatestByPolicy(
      decisionPolicyId,
    );
    const context = await this.requireContext(policy.decisionContextId);
    const fingerprints = await this.governanceFingerprints(context);
    this.assertGovernanceUnchanged(policy, fingerprints);
    const causalOk = await this.causalBindingsLiveFlag(policy, context);
    assertActivationReady(
      assessDecisionPolicyActivationReadiness({
        policy,
        context,
        shadowEvaluation: shadowEval,
        causalBindingsStillValid: causalOk,
        governanceCurrent: true,
        capabilitiesCurrent: true,
        nowIso: this.deps.nowIso(),
      }),
    );
    if (!shadowEval) {
      throw new DecisionPolicyError(
        "ACTIVATION_NOT_READY",
        "Persisted shadow evaluation required before activation routing",
      );
    }
    const approval = await this.deps.approvalRequests.getLatestByPolicy(
      decisionPolicyId,
    );
    if (!approval || approval.decision !== "APPROVE_SHADOW") {
      throw new DecisionPolicyError(
        "DECISION_POLICY_ACTIVATION_INVALID",
        "SHADOW approval required before activation",
      );
    }
    const approvalRecordId = (
      await this.deps.approvalRecords.getById(
        // find via request id — store lookup from records by scanning not available;
        // use mint identity from request
        mintDecisionPolicyApprovalRecordId({
          decisionPolicyApprovalRequestId:
            approval.decisionPolicyApprovalRequestId,
          decidedAt: approval.decidedAt ?? approval.createdAt,
        }),
      )
    )?.decisionPolicyApprovalRecordId;

    const now = this.deps.nowIso();
    const expiresAt = new Date(
      Date.parse(now) +
        (this.deps.activationWindowMs ?? DEFAULT_ACTIVATION_WINDOW_MS),
    ).toISOString();
    const validUntil = new Date(
      Date.parse(now) + 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const nonce = issueDecisionNonce(this.nonceGenerator);
    const subjectHash = computeActivationSubjectHash({
      decisionPolicyId: policy.decisionPolicyId,
      decisionPolicyVersion: policy.decisionPolicyVersion,
      policyHash: policy.policyHash,
      shadowEvaluationId: shadowEval.decisionPolicyShadowEvaluationId,
      shadowEvaluationHash: shadowEval.shadowEvaluationHash,
      approvalRecordId:
        approvalRecordId ?? approval.decisionPolicyApprovalRequestId,
      governancePolicyFingerprint: fingerprints.policy,
      capabilitySetFingerprint: fingerprints.capabilities,
      expiresAt,
    });
    const request = await this.deps.activationRequests.save({
      decisionPolicyActivationRequestId: mintActivationRequestId({
        decisionPolicyId: policy.decisionPolicyId,
        policyHash: policy.policyHash,
        shadowEvaluationHash: shadowEval.shadowEvaluationHash,
      }),
      decisionPolicyId: policy.decisionPolicyId,
      decisionPolicyVersion: policy.decisionPolicyVersion,
      policyHash: policy.policyHash,
      shadowEvaluationId: shadowEval.decisionPolicyShadowEvaluationId,
      shadowEvaluationHash: shadowEval.shadowEvaluationHash,
      approvalRecordId:
        approvalRecordId ?? approval.decisionPolicyApprovalRequestId,
      approvedScopeProjectIds: [...context.projectIds],
      approvedScopeEnvironments: [...context.environmentScope],
      governancePolicyFingerprint: fingerprints.policy,
      capabilitySetFingerprint: fingerprints.capabilities,
      riskLimits: {
        maxUnsupportedStateRate:
          policy.riskConstraints.maxUnsupportedStateRate,
        maxConstraintViolations: policy.riskConstraints.maxConstraintViolations,
        maxStaleSourceRate: policy.riskConstraints.maxStaleSourceRate,
        ...(policy.riskConstraints.maxObservedLoss !== undefined
          ? { maxObservedLoss: policy.riskConstraints.maxObservedLoss }
          : {}),
      },
      activationWindow: { validFrom: now, validUntil },
      subjectHash,
      decisionNonceHash: nonce.nonceHash,
      status: "PENDING",
      expiresAt,
      createdAt: now,
      recordRevision: 1,
    });
    return { policy, request, decisionNonce: nonce.plaintext };
  }

  async decideActivation(input: {
    decisionPolicyActivationRequestId: string;
    activatorId: string;
    decision: DecisionPolicyActivationDecision;
    decisionNonce: string;
    submittedAt?: string;
  }): Promise<{
    policy: DecisionPolicyCandidate;
    activation?: DecisionPolicyActivationRecord;
  }> {
    const request = await this.deps.activationRequests.getById(
      input.decisionPolicyActivationRequestId,
    );
    if (!request || request.status !== "PENDING") {
      throw new DecisionPolicyError(
        "DECISION_POLICY_ACTIVATION_INVALID",
        "Activation request missing or not PENDING",
      );
    }
    const submittedAt = input.submittedAt ?? this.deps.nowIso();
    if (Date.parse(submittedAt) > Date.parse(request.expiresAt)) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_ACTIVATION_EXPIRED",
        "Activation request expired",
      );
    }
    if (hashDecisionNonce(input.decisionNonce) !== request.decisionNonceHash) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_ACTIVATION_INVALID",
        "Decision nonce mismatch / replay",
      );
    }
    if (!this.deps.isDecisionPolicyActivator) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_ACTIVATOR_SCOPE_INSUFFICIENT",
        "Decision policy activator checker not configured",
      );
    }
    const allowed = await this.deps.isDecisionPolicyActivator(
      input.activatorId,
      request.approvedScopeProjectIds,
    );
    if (!allowed) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_ACTIVATOR_SCOPE_INSUFFICIENT",
        "Principal is not DECISION_POLICY_ACTIVATOR for all projects",
      );
    }
    const policy = await this.requirePolicy(request.decisionPolicyId);
    if (policy.policyHash !== request.policyHash) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_ACTIVATION_INVALID",
        "Policy hash drift — activation cannot repoint",
      );
    }
    if (input.decision === "ACTIVATE") {
      const context = await this.requireContext(policy.decisionContextId);
      const fingerprints = await this.governanceFingerprints(context);
      const governanceCurrent =
        !policy.governancePolicyFingerprint ||
        policy.governancePolicyFingerprint === fingerprints.policy;
      const capabilitiesCurrent =
        !policy.capabilitySetFingerprint ||
        policy.capabilitySetFingerprint === fingerprints.capabilities;
      const persistedEval = await this.deps.shadowEvaluations.getById(
        request.shadowEvaluationId,
      );
      if (
        !persistedEval ||
        persistedEval.shadowEvaluationHash !== request.shadowEvaluationHash
      ) {
        throw new DecisionPolicyError(
          "ACTIVATION_NOT_READY",
          "Activation must resolve persisted shadow evaluation; caller-supplied metrics are not authority",
        );
      }
      const causalOk = await this.causalBindingsLiveFlag(policy, context);
      assertActivationReady(
        assessDecisionPolicyActivationReadiness({
          policy,
          context,
          shadowEvaluation: persistedEval,
          causalBindingsStillValid: causalOk,
          governanceCurrent,
          capabilitiesCurrent,
          nowIso: submittedAt,
        }),
      );
    }
    await this.deps.activationRequests.save({
      ...request,
      status: "DECIDED",
      activatorId: input.activatorId,
      decision: input.decision,
      decidedAt: submittedAt,
      recordRevision: request.recordRevision + 1,
    });
    if (input.decision === "REJECT") {
      return { policy: await this.transition(policy, "REJECTED") };
    }
    if (input.decision === "REQUEST_MORE_SHADOW_EVIDENCE") {
      return { policy: await this.transition(policy, "SHADOW_RUNNING") };
    }
    const activationHash = computeActivationHash({
      decisionPolicyId: policy.decisionPolicyId,
      decisionPolicyVersion: policy.decisionPolicyVersion,
      policyHash: policy.policyHash,
      shadowEvaluationHash: request.shadowEvaluationHash,
      activationAuthorityPrincipalId: input.activatorId,
      validFrom: request.activationWindow.validFrom,
      validUntil: request.activationWindow.validUntil,
      governancePolicyFingerprint: request.governancePolicyFingerprint,
      capabilitySetFingerprint: request.capabilitySetFingerprint,
    });
    const activation = await this.deps.activationRecords.save({
      decisionPolicyActivationId: mintActivationRecordId({
        decisionPolicyActivationRequestId:
          request.decisionPolicyActivationRequestId,
        decidedAt: submittedAt,
      }),
      decisionPolicyActivationVersion: 1,
      decisionPolicyActivationRequestId:
        request.decisionPolicyActivationRequestId,
      decisionPolicyId: policy.decisionPolicyId,
      decisionPolicyVersion: policy.decisionPolicyVersion,
      policyHash: policy.policyHash,
      shadowEvaluationHash: request.shadowEvaluationHash,
      activationScopeProjectIds: [...request.approvedScopeProjectIds],
      activationScopeEnvironments: [...request.approvedScopeEnvironments],
      activationAuthorityPrincipalId: input.activatorId,
      validFrom: request.activationWindow.validFrom,
      validUntil: request.activationWindow.validUntil,
      runtimeConstraints: { ...request.riskLimits },
      governancePolicyFingerprint: request.governancePolicyFingerprint,
      capabilitySetFingerprint: request.capabilitySetFingerprint,
      activationHash,
      status: "ACTIVE",
      createdAt: submittedAt,
    });
    const next = await this.transition(policy, "ACTIVE");
    return { policy: next, activation };
  }

  async recommend(input: {
    decisionPolicyId: string;
    environment: string;
    hints?: DecisionStateValues;
  }): Promise<{
    recommendation: DecisionRecommendation;
    materialization: MaterializationResult;
  }> {
    const policy = await this.requirePolicy(input.decisionPolicyId);
    if (policy.status !== "ACTIVE") {
      throw new DecisionPolicyError(
        "DECISION_POLICY_NOT_ACTIVE",
        `Live recommendation requires ACTIVE policy (got ${policy.status})`,
      );
    }
    const activation = await this.deps.activationRecords.getActiveByPolicy(
      policy.decisionPolicyId,
    );
    if (!activation || activation.status !== "ACTIVE") {
      throw new DecisionPolicyError(
        "DECISION_POLICY_NOT_ACTIVE",
        "No ACTIVE activation record",
      );
    }
    const context = await this.requireContext(policy.decisionContextId);
    const fingerprints = await this.governanceFingerprints(context);
    this.assertGovernanceUnchanged(policy, fingerprints);
    await this.assertCausalBindingsLive(policy, context);

    const snapshot = await this.resolveAuthoritativeSnapshot({
      context,
      environment: input.environment,
      ...(input.hints !== undefined ? { hints: input.hints } : {}),
    });
    await this.deps.snapshots.save(snapshot);

    const selected = selectActionForState({
      policy,
      context,
      stateValues: snapshot.values,
    });
    const action = context.eligibleActions.find(
      (a) => a.actionId === selected.actionId,
    );
    if (!action) {
      throw new DecisionPolicyError(
        "DECISION_ACTION_INELIGIBLE",
        `Recommended action ${selected.actionId} not eligible`,
      );
    }

    const identityHash = computeRecommendationIdentity({
      policyId: policy.decisionPolicyId,
      policyVersion: policy.decisionPolicyVersion,
      policyHash: policy.policyHash,
      activationHash: activation.activationHash,
      stateSnapshotHash: snapshot.snapshotHash,
    });
    const existing = await this.deps.recommendations.findByIdentityHash(
      identityHash,
    );
    if (existing) {
      return {
        recommendation: existing,
        materialization: {
          kind: "PERSISTED_ONLY",
          recommendationId: existing.decisionRecommendationId,
        },
      };
    }

    const matchedRule = policy.rules.find(
      (r) => r.decisionRuleId === selected.matchedRuleId,
    );
    const recommendation: DecisionRecommendation = {
      decisionRecommendationId: mintDecisionRecommendationId(identityHash),
      decisionPolicyId: policy.decisionPolicyId,
      decisionPolicyVersion: policy.decisionPolicyVersion,
      policyHash: policy.policyHash,
      activationRecordId: activation.decisionPolicyActivationId,
      activationHash: activation.activationHash,
      stateSnapshotId: snapshot.decisionStateSnapshotId,
      stateSnapshotHash: snapshot.snapshotHash,
      matchedRuleId: selected.matchedRuleId,
      recommendedActionId: selected.actionId,
      executionPath: action.executionPath,
      evidenceRefs: matchedRule?.evidenceRefs ?? [],
      ...(matchedRule?.expectedOutcome
        ? { expectedOutcome: matchedRule.expectedOutcome.description }
        : {}),
      uncertainty: "MEDIUM",
      riskClass: action.riskClass,
      requiredDownstreamAuthority: [...action.authorityRequirements],
      recommendationHash: identityHash,
      createdAt: this.deps.nowIso(),
      attribution: {
        recommendedByPolicy: true,
        materializedFromRecommendation: false,
        authorizedDownstream: false,
        executed: false,
        verifiedOutcome: false,
      },
    };
    await this.deps.recommendations.save(recommendation);
    const materialization = this.compiler.persistOnly(recommendation);
    await this.deps.performance.save({
      decisionPolicyPerformanceRecordId: `dperf_${identityHash.slice(0, 16)}`,
      decisionPolicyId: policy.decisionPolicyId,
      decisionPolicyVersion: policy.decisionPolicyVersion,
      recommendationId: recommendation.decisionRecommendationId,
      recommendations: 1,
      materializations: 0,
      verifiedDownstreamOutcomes: 0,
      constraintViolations: 0,
      resourceUse: {},
      scopeProjectIds: [...context.projectIds],
      measurementQuality: "PARTIAL",
      attributionStages: [
        "RECOMMENDED_BY_POLICY",
        ...(materialization.kind !== "PERSISTED_ONLY" &&
        materialization.kind !== "NO_ACTION"
          ? ["MATERIALIZED_FROM_RECOMMENDATION"]
          : []),
      ],
      createdAt: this.deps.nowIso(),
    });
    return { recommendation, materialization };
  }

  /**
   * Explicit submit. ACTIVE != automatic proposal submission.
   * Reuses lineage / downstream identity on retry.
   */
  async materializeRecommendation(input: {
    recommendationId: string;
  }): Promise<{
    recommendation: DecisionRecommendation;
    materialization: MaterializationResult;
    lineage: DecisionRecommendationMaterializationLineage;
  }> {
    const recommendation = await this.deps.recommendations.getById(
      input.recommendationId,
    );
    if (!recommendation) {
      throw new DecisionPolicyError(
        "DECISION_RECOMMENDATION_INVALID",
        "Recommendation not found",
      );
    }
    if (!this.deps.materializationLineages) {
      throw new DecisionPolicyError(
        "DECISION_DOWNSTREAM_PORT_UNAVAILABLE",
        "Materialization lineage repository not configured",
      );
    }
    const existing = await this.deps.materializationLineages.getByRecommendationHash(
      recommendation.recommendationHash,
    );
    if (existing) {
      return {
        recommendation,
        materialization: lineageToResult(existing),
        lineage: existing,
      };
    }
    const policy = await this.requirePolicy(recommendation.decisionPolicyId);
    const context = await this.requireContext(policy.decisionContextId);
    const action = context.eligibleActions.find(
      (a) => a.actionId === recommendation.recommendedActionId,
    );
    if (!action) {
      throw new DecisionPolicyError(
        "DECISION_ACTION_INELIGIBLE",
        "Recommended action is not eligible",
      );
    }
    const materialization = await this.compiler.materialize({
      recommendation,
      action,
    });
    const downstreamObjectId = downstreamIdFromResult(materialization);
    const lineageBase = {
      materializationLineageId: mintMaterializationLineageId(
        recommendation.recommendationHash,
      ),
      recommendationId: recommendation.decisionRecommendationId,
      recommendationHash: recommendation.recommendationHash,
      decisionPolicyId: recommendation.decisionPolicyId,
      decisionPolicyVersion: recommendation.decisionPolicyVersion,
      policyHash: recommendation.policyHash,
      activationId: recommendation.activationRecordId,
      activationHash: recommendation.activationHash,
      stateSnapshotHash: recommendation.stateSnapshotHash,
      actionId: recommendation.recommendedActionId,
      executionPath: recommendation.executionPath,
      downstreamLogicalIdentity:
        "downstreamLogicalIdentity" in materialization
          ? materialization.downstreamLogicalIdentity
          : mintMaterializationLineageId(recommendation.recommendationHash),
      downstreamObjectId,
      materializationStatus: "SETTLED" as const,
      createdAt: this.deps.nowIso(),
    };
    const lineage =
      await this.deps.materializationLineages.save({
        ...lineageBase,
        lineageHash: computeLineageHash(lineageBase),
      });
    await this.deps.recommendations.save({
      ...recommendation,
      attribution: {
        ...recommendation.attribution,
        materializedFromRecommendation:
          materialization.kind !== "PERSISTED_ONLY" &&
          materialization.kind !== "NO_ACTION",
        authorizedDownstream: false,
        executed: false,
      },
    });
    return { recommendation, materialization, lineage };
  }

  async overrideRecommendation(input: {
    recommendationId: string;
    principalId: string;
    humanDecision: DecisionOverrideRecord["humanDecision"];
    reasonCategory: DecisionOverrideRecord["reasonCategory"];
    overrideActionId?: string;
    notes?: string;
  }): Promise<{ override: DecisionOverrideRecord }> {
    const recommendation = await this.deps.recommendations.getById(
      input.recommendationId,
    );
    if (!recommendation) {
      throw new DecisionPolicyError(
        "DECISION_RECOMMENDATION_INVALID",
        "Recommendation not found",
      );
    }
    const override: DecisionOverrideRecord = {
      decisionOverrideRecordId: `dovr_${createHash("sha256")
        .update(
          `${input.recommendationId}:${input.principalId}:${this.deps.nowIso()}`,
          "utf8",
        )
        .digest("hex")
        .slice(0, 16)}`,
      recommendationId: input.recommendationId,
      humanDecision: input.humanDecision,
      reasonCategory: input.reasonCategory,
      ...(input.overrideActionId
        ? { overrideActionId: input.overrideActionId }
        : {}),
      principalId: input.principalId,
      timestamp: this.deps.nowIso(),
      ...(input.notes ? { notes: input.notes } : {}),
    };
    await this.deps.overrides.save(override);
    return { override };
  }

  async pauseForSafety(
    decisionPolicyId: string,
    reason: string,
  ): Promise<{
    policy: DecisionPolicyCandidate;
    revision: DecisionPolicyRevisionCandidate;
  }> {
    const policy = await this.requirePolicy(decisionPolicyId);
    if (policy.status !== "ACTIVE" && policy.status !== "SHADOW_RUNNING") {
      throw new DecisionPolicyError(
        "DECISION_POLICY_STATE_CONFLICT",
        `pauseForSafety requires ACTIVE or SHADOW_RUNNING (got ${policy.status})`,
      );
    }
    const next = await this.transition(policy, "PAUSED");
    const activation = await this.deps.activationRecords.getActiveByPolicy(
      decisionPolicyId,
    );
    if (activation) {
      await this.deps.activationRecords.save({
        ...activation,
        status: "PAUSED",
      });
    }
    const revision = mintRevisionCandidate({
      sourcePolicyId: policy.decisionPolicyId,
      sourcePolicyVersion: policy.decisionPolicyVersion,
      sourcePolicyHash: policy.policyHash,
      reason,
      riskImpact: "HIGH",
      createdAt: this.deps.nowIso(),
      proposedRuleChanges: [],
      proposedThresholdChanges: [],
    });
    await this.deps.revisions.save(revision);
    // Active rules remain immutable — revision is a proposal only.
    return { policy: next, revision };
  }

  async markStaleFromCausalDrift(
    decisionPolicyId: string,
  ): Promise<DecisionPolicyCandidate> {
    const policy = await this.requirePolicy(decisionPolicyId);
    if (policy.status === "ACTIVE" || policy.status === "SHADOW_RUNNING") {
      return this.transition(policy, "PAUSED");
    }
    return this.transition(policy, "STALE");
  }

  assessConcentration(decisionPolicyId: string, actionCounts: Record<string, number>) {
    return this.requirePolicy(decisionPolicyId).then((policy) =>
      assessPolicyConcentration({
        decisionPolicyId: policy.decisionPolicyId,
        decisionPolicyVersion: policy.decisionPolicyVersion,
        actionCounts,
        expectedDiversity: true,
      }),
    );
  }

  async resolveSnapshot(input: {
    context: DecisionContext;
    environment: string;
    hints?: DecisionStateValues;
  }): Promise<DecisionStateSnapshot> {
    return this.resolveAuthoritativeSnapshot(input);
  }

  private async requireContext(id: string): Promise<DecisionContext> {
    const context = await this.deps.contexts.getById(id);
    if (!context) {
      throw new DecisionPolicyError(
        "DECISION_CONTEXT_NOT_FOUND",
        `Decision context ${id} not found`,
      );
    }
    return context;
  }

  private async requirePolicy(id: string): Promise<DecisionPolicyCandidate> {
    const policy = await this.deps.policies.getById(id);
    if (!policy) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_NOT_FOUND",
        `Decision policy ${id} not found`,
      );
    }
    return policy;
  }

  private async transition(
    policy: DecisionPolicyCandidate,
    to: DecisionPolicyCandidate["status"],
  ): Promise<DecisionPolicyCandidate> {
    assertDecisionPolicyTransition(policy.status, to);
    return this.deps.policies.transition(
      policy.decisionPolicyId,
      policy.status,
      policy.recordRevision,
      to,
      this.deps.nowIso(),
    );
  }

  private async governanceFingerprints(context: DecisionContext): Promise<{
    policy: string;
    capabilities: string;
  }> {
    const projectId = context.projectIds[0]!;
    const env = context.environmentScope[0]!;
    const resolved = await this.deps.controlPlane.resolve(projectId, env);
    return {
      policy: resolved.activePolicyBundle.policyHash,
      capabilities: createHash("sha256")
        .update(
          JSON.stringify(
            resolved.availableCapabilities.map((c) => ({
              id: c.capabilityId,
              enabled: c.enabled,
            })),
          ),
          "utf8",
        )
        .digest("hex"),
    };
  }

  private assertGovernanceUnchanged(
    policy: DecisionPolicyCandidate,
    fingerprints: { policy: string; capabilities: string },
  ): void {
    if (
      policy.governancePolicyFingerprint &&
      policy.governancePolicyFingerprint !== fingerprints.policy
    ) {
      throw new DecisionPolicyError(
        "DECISION_GOVERNANCE_DRIFT",
        "Governance policy fingerprint changed — fail closed",
      );
    }
    if (
      policy.capabilitySetFingerprint &&
      policy.capabilitySetFingerprint !== fingerprints.capabilities
    ) {
      throw new DecisionPolicyError(
        "DECISION_GOVERNANCE_DRIFT",
        "Capability set fingerprint changed — fail closed",
      );
    }
  }

  private async resolveAuthoritativeSnapshot(input: {
    context: DecisionContext;
    environment: string;
    hints?: DecisionStateValues;
  }): Promise<DecisionStateSnapshot> {
    if (!this.stateResolver) {
      throw new DecisionPolicyError(
        "DECISION_STATE_INSUFFICIENT",
        "Authoritative DecisionStateSourcePort is not configured",
      );
    }
    return this.stateResolver.resolve(input);
  }

  private async resolveCausalBindings(
    context: DecisionContext,
    claimIds: readonly string[],
    opts: { allowPartial: boolean },
  ): Promise<CausalEvidenceBinding[]> {
    if (claimIds.length === 0) return [];
    if (!this.deps.causalEvidence) {
      throw new DecisionPolicyError(
        "DECISION_CAUSAL_EVIDENCE_NOT_SUPPORTED",
        "Causal sources require CausalGovernedEvidencePort — ACTIVE status alone is not proof",
      );
    }
    const bindings: CausalEvidenceBinding[] = [];
    for (const claimId of claimIds) {
      const evidence = await this.deps.causalEvidence.resolve({
        promotedCausalClaimId: claimId,
        requestingProjectIds: context.projectIds,
        requestingEnvironment: context.environmentScope[0]!,
      });
      if (!evidence) {
        throw new DecisionPolicyError(
          "DECISION_CAUSAL_EVIDENCE_STALE",
          `Promoted causal claim ${claimId} could not be resolved through governed causal retrieval`,
        );
      }
      const scope = assessCausalScopeCompatibility({ evidence, context });
      assertCausalEvidenceUsableForAuthority({
        evidence,
        scope,
        allowPartial: opts.allowPartial,
      });
      bindings.push(bindCausalEvidence(evidence, scope));
    }
    return bindings;
  }

  private async assertCausalBindingsLive(
    policy: DecisionPolicyCandidate,
    context: DecisionContext,
  ): Promise<void> {
    const ok = await this.causalBindingsLiveFlag(policy, context);
    if (!ok) {
      throw new DecisionPolicyError(
        "DECISION_CAUSAL_EVIDENCE_STALE",
        "Bound causal evidence is stale, superseded, or no longer in scope",
      );
    }
  }

  private async causalBindingsLiveFlag(
    policy: DecisionPolicyCandidate,
    context: DecisionContext,
  ): Promise<boolean> {
    if (
      policy.sourcePromotedCausalClaimIds.length === 0 &&
      policy.sourceCausalBindings.length === 0
    ) {
      return true;
    }
    try {
      const live = await this.resolveCausalBindings(
        context,
        policy.sourcePromotedCausalClaimIds,
        { allowPartial: false },
      );
      if (policy.sourceCausalBindings.length > 0) {
        return causalBindingsStillMatch(policy.sourceCausalBindings, live);
      }
      return live.length === policy.sourcePromotedCausalClaimIds.length;
    } catch {
      return false;
    }
  }
}

function lineageToResult(
  lineage: DecisionRecommendationMaterializationLineage,
): MaterializationResult {
  switch (lineage.executionPath) {
    case "OBJECTIVE":
      return {
        kind: "OBJECTIVE_PROPOSAL",
        recommendationId: lineage.recommendationId,
        objectiveAdmissionId: lineage.downstreamObjectId,
        downstreamLogicalIdentity: lineage.downstreamLogicalIdentity,
      };
    case "PROGRAM":
      return {
        kind: "PROGRAM_PROPOSAL",
        recommendationId: lineage.recommendationId,
        programProposalId: lineage.downstreamObjectId,
        downstreamLogicalIdentity: lineage.downstreamLogicalIdentity,
      };
    case "PORTFOLIO_PROPOSAL":
      return {
        kind: "PORTFOLIO_PROPOSAL",
        recommendationId: lineage.recommendationId,
        portfolioProposalId: lineage.downstreamObjectId,
        downstreamLogicalIdentity: lineage.downstreamLogicalIdentity,
      };
    case "EXPERIMENT_PROPOSAL":
      return {
        kind: "EXPERIMENT_PROPOSAL",
        recommendationId: lineage.recommendationId,
        experimentProposalId: lineage.downstreamObjectId,
        downstreamLogicalIdentity: lineage.downstreamLogicalIdentity,
      };
    case "NO_ACTION":
      return { kind: "NO_ACTION", recommendationId: lineage.recommendationId };
    default:
      return {
        kind: "PERSISTED_ONLY",
        recommendationId: lineage.recommendationId,
      };
  }
}

function downstreamIdFromResult(result: MaterializationResult): string {
  switch (result.kind) {
    case "OBJECTIVE_PROPOSAL":
      return result.objectiveAdmissionId;
    case "PROGRAM_PROPOSAL":
      return result.programProposalId;
    case "PORTFOLIO_PROPOSAL":
      return result.portfolioProposalId;
    case "EXPERIMENT_PROPOSAL":
      return result.experimentProposalId;
    default:
      return result.recommendationId;
  }
}
