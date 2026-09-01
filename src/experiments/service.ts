import { createHash } from "node:crypto";
import type { ControlPlaneService } from "../control-plane/service.js";
import {
  issueDecisionNonce,
  type DecisionNonceGenerator,
} from "../authorization/decision-nonce.js";
import { hashDecisionNonce } from "../authorization/decision-card-hasher.js";
import { capabilitySetFingerprint } from "../execution/capability-fingerprint.js";
import { projectConfigurationFingerprint } from "../programs/authority.js";
import {
  withOptionalTransaction,
  type TransactionManager,
} from "../durability/transaction.js";
import { assertInstitutionalRequirements } from "../governance/phase-gate.js";
import {
  assertExperimentAuthorizationDoesNotExecute,
  assertExperimentSponsorDistinctFromApprover,
  assertExperimentSponsorDistinctFromStrategySelector,
  budgetFingerprint,
  computeExperimentAuthSubjectHash,
  EXPERIMENT_SPONSOR_AUTHORITY_BOUNDARIES,
  mintExperimentAuthorizationId,
  mintExperimentAuthorizationRecordId,
  type ExperimentAuthorizationDecision,
  type ExperimentAuthorizationRecord,
  type ExperimentAuthorizationRequest,
} from "./authorization.js";
import {
  fakeAssumptionBindingsFor,
  type ExperimentDesignModel,
} from "./design-model.js";
import { ExperimentError } from "./errors.js";
import {
  buildAssumptionUpdateCandidate,
  resolveHypothesisOutcomes,
} from "./assumption-candidates.js";
import {
  reserveExperimentUsage,
  sampleCountDelta,
} from "./budget-ledger.js";
import {
  compileExperimentToObjective,
  type CompiledExperimentObjective,
} from "./execution-compiler.js";
import {
  mintCompletionRecordId,
  mintEvidenceBundleId,
  mintExperimentResultId,
  withEvidenceBundleHash,
  type AssumptionEvidenceUpdateCandidate,
  type ExperimentCompletionRecord,
  type ExperimentEvidenceBundle,
  type ExperimentExecutionLineage,
  type ExperimentResult,
  type MeasurementResult,
} from "./evidence.js";
import type { ExperimentObjectiveAdmissionPort } from "./objective-admission-port.js";
import {
  phase8AllowsConclusiveHypothesis,
  resolveBoundPhase8Verifications,
  worstAuthoritativeQuality,
  type ExperimentOutcomeVerificationPort,
} from "./outcome-verification-port.js";
import {
  assertExperimentTransition,
  experimentContentFingerprint,
  experimentIdempotencyKey,
  INITIAL_EXPERIMENT_VERSION,
  mintExperimentId,
  parseGovernedExperiment,
  type ExperimentBudgetEnvelope,
  type GovernedExperiment,
} from "./experiment.js";
import {
  INITIAL_EXPERIMENT_PLAN_VERSION,
  withExperimentPlanHash,
  type ExperimentPlan,
  type ExperimentStoppingRule,
} from "./plan.js";
import type {
  ExperimentHypothesis,
  ExperimentMeasurement,
} from "./hypothesis.js";
import type {
  AssumptionEvidenceUpdateCandidateRepository,
  ExperimentAuthorizationRecordRepository,
  ExperimentAuthorizationRequestRepository,
  ExperimentCompletionRecordRepository,
  ExperimentEvidenceBundleRepository,
  ExperimentExecutionLineageRepository,
  ExperimentPlanRepository,
  ExperimentRepository,
  ExperimentResultRepository,
  ExperimentUsageLedgerRepository,
} from "./repositories.js";
import {
  assertValidExperimentPlan,
  validateExperimentPlan,
} from "./validator.js";

export interface ExperimentAdmissionRequest {
  experimentId?: string;
  experimentVersion?: number;
  projectId: string;
  requestedEnvironment: string;
  sourceDecisionProblemId?: string;
  sourceDecisionProblemVersion?: number;
  sourceScenarioSetId?: string;
  sourceScenarioSetVersion?: number;
  sourceAssumptionIds?: string[];
  sourceAssumptionSetHash?: string;
  sourcePortfolioId?: string;
  sourcePortfolioVersion?: number;
  objective: string;
  constraints?: string[];
  nonGoals?: string[];
  riskClass: GovernedExperiment["riskClass"];
  budgetEnvelope: ExperimentBudgetEnvelope;
  createdBy: string;
  correlationId?: string;
  traceId?: string;
  submittedAt: string;
}

export type ExperimentAdmissionOutcome =
  | { outcome: "ADMITTED"; experiment: GovernedExperiment }
  | { outcome: "DUPLICATE"; experiment: GovernedExperiment }
  | {
      outcome: "VERSION_CONFLICT";
      existing: GovernedExperiment;
      message: string;
    };

export interface ExperimentCompletionFailpoint {
  afterEvidence?(): Promise<void>;
}

export interface ExperimentCompileFailpoint {
  afterAdmit?(): Promise<void>;
  afterLineage?(): Promise<void>;
}

export interface ExperimentOrchestrationServiceDeps {
  nowIso: () => string;
  experiments: ExperimentRepository;
  plans: ExperimentPlanRepository;
  authRequests: ExperimentAuthorizationRequestRepository;
  authRecords: ExperimentAuthorizationRecordRepository;
  results: ExperimentResultRepository;
  evidenceBundles: ExperimentEvidenceBundleRepository;
  updateCandidates: AssumptionEvidenceUpdateCandidateRepository;
  completions: ExperimentCompletionRecordRepository;
  lineage: ExperimentExecutionLineageRepository;
  usageLedger: ExperimentUsageLedgerRepository;
  controlPlane: ControlPlaneService;
  designModel: ExperimentDesignModel;
  nonceGenerator: DecisionNonceGenerator;
  authNonceStore?: {
    put(authorizationId: string, plaintext: string): Promise<void>;
    take(authorizationId: string): Promise<string | null>;
  };
  /** Must hold EXPERIMENT_SPONSOR for the experiment project. */
  isExperimentSponsor?: (
    principalId: string,
    projectIds: readonly string[],
  ) => Promise<boolean>;
  /** Phase 20 optional institutional hold gate. */
  institutionalGovernance?: import("../governance/port.js").InstitutionalGovernancePort;
  /** Production: Phase2ExperimentObjectiveAdmissionPort. Missing → fail closed. */
  objectiveAdmissionPort?: ExperimentObjectiveAdmissionPort;
  /** Production: Phase8ExperimentOutcomeVerificationPort. Missing → fail closed for conclusive evidence. */
  outcomeVerificationPort?: ExperimentOutcomeVerificationPort;
  /** Optional: resolve admitted run project for cross-project fail-closed checks. */
  resolveRunProjectId?: (runId: string) => Promise<string | null>;
  transactions?: TransactionManager;
  completionFailpoint?: ExperimentCompletionFailpoint;
  compileFailpoint?: ExperimentCompileFailpoint;
}

export const EXPERIMENT_AUTHORITY_BOUNDARIES = {
  ...EXPERIMENT_SPONSOR_AUTHORITY_BOUNDARIES,
  evidence:
    "Experiment evidence may propose assumption updates — never mutate AssumptionSets",
  compilation:
    "Experiment compilation produces Objective admission intent — never Phase 6 auth or execution",
} as const;

export function assertExperimentAuthoritySeparation(): void {
  assertExperimentAuthorizationDoesNotExecute();
  assertExperimentSponsorDistinctFromApprover();
  assertExperimentSponsorDistinctFromStrategySelector();
}

export class ExperimentOrchestrationService {
  constructor(private readonly deps: ExperimentOrchestrationServiceDeps) {}

  assertAuthoritySeparation(): void {
    assertExperimentAuthoritySeparation();
  }

  async admit(
    request: ExperimentAdmissionRequest,
  ): Promise<ExperimentAdmissionOutcome> {
    const context = await this.deps.controlPlane.resolve(
      request.projectId,
      request.requestedEnvironment,
    );
    const sourceAssumptionIds = request.sourceAssumptionIds ?? [];
    const contentFingerprint = experimentContentFingerprint({
      projectId: request.projectId,
      objective: request.objective,
      sourceAssumptionIds,
      ...(request.sourceDecisionProblemId
        ? { sourceDecisionProblemId: request.sourceDecisionProblemId }
        : {}),
    });
    const idempotencyKey = experimentIdempotencyKey({
      projectId: request.projectId,
      contentFingerprint,
      createdBy: request.createdBy,
    });

    const existing =
      await this.deps.experiments.getByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.contentFingerprint !== contentFingerprint) {
        return {
          outcome: "VERSION_CONFLICT",
          existing,
          message: "Same experiment identity with different semantic content",
        };
      }
      return { outcome: "DUPLICATE", experiment: existing };
    }

    const now = request.submittedAt;
    const caps = context.availableCapabilities.map((c) => ({
      capabilityId: c.capabilityId,
      version: c.version,
      enabled: c.enabled,
      allowedActions: c.allowedActions,
      forbiddenActions: c.forbiddenActions,
      allowedEnvironments: c.allowedEnvironments,
      approvalRequirement: c.approvalRequirement,
      maximumRuntimeSeconds: c.maximumRuntimeSeconds,
    }));
    const policyBundleFingerprint = context.activePolicyBundle.policyHash;
    const capFp = capabilitySetFingerprint(caps);
    const projFp = projectConfigurationFingerprint({
      projectId: request.projectId,
      activePolicyBundleId: context.project.activePolicyBundleId,
      budgetProfileId: context.project.resourceBudgetProfileId,
      allowedEnvironments: context.project.allowedEnvironments,
      executionMode: context.project.executionMode,
    });
    const truthSnapshotFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          capabilitySetFingerprint: capFp,
          policyBundleFingerprint,
          projectConfigurationFingerprint: projFp,
        }),
        "utf8",
      )
      .digest("hex");

    const experimentId =
      request.experimentId ??
      mintExperimentId({
        projectId: request.projectId,
        contentFingerprint,
        admittedAt: now,
      });

    const experiment = parseGovernedExperiment({
      experimentId,
      experimentVersion:
        request.experimentVersion ?? INITIAL_EXPERIMENT_VERSION,
      projectId: request.projectId,
      requestedEnvironment: request.requestedEnvironment,
      ...(request.sourceDecisionProblemId
        ? { sourceDecisionProblemId: request.sourceDecisionProblemId }
        : {}),
      ...(request.sourceDecisionProblemVersion !== undefined
        ? {
            sourceDecisionProblemVersion: request.sourceDecisionProblemVersion,
          }
        : {}),
      ...(request.sourceScenarioSetId
        ? { sourceScenarioSetId: request.sourceScenarioSetId }
        : {}),
      ...(request.sourceScenarioSetVersion !== undefined
        ? { sourceScenarioSetVersion: request.sourceScenarioSetVersion }
        : {}),
      sourceAssumptionIds,
      ...(request.sourceAssumptionSetHash
        ? { sourceAssumptionSetHash: request.sourceAssumptionSetHash }
        : {}),
      ...(request.sourcePortfolioId
        ? { sourcePortfolioId: request.sourcePortfolioId }
        : {}),
      ...(request.sourcePortfolioVersion !== undefined
        ? { sourcePortfolioVersion: request.sourcePortfolioVersion }
        : {}),
      objective: request.objective,
      constraints: request.constraints ?? [],
      nonGoals: request.nonGoals ?? [],
      riskClass: request.riskClass,
      budgetEnvelope: request.budgetEnvelope,
      hypotheses: [],
      measurements: [],
      assumptionBindings: [],
      status: "ADMITTED",
      policyBundleFingerprint,
      capabilitySetFingerprint: capFp,
      projectConfigurationFingerprint: projFp,
      truthSnapshotFingerprint,
      createdBy: request.createdBy,
      createdAt: now,
      updatedAt: now,
      recordRevision: 1,
      correlationId: request.correlationId ?? `corr_${experimentId}`,
      traceId: request.traceId ?? `trace_${experimentId}`,
      idempotencyKey,
      contentFingerprint,
    });

    const created = await this.deps.experiments.create(experiment);
    await this.deps.usageLedger.create({
      experimentId: created.experimentId,
      designCalls: 0,
      modelCalls: 0,
      sampleCount: 0,
      reservedActions: 0,
      committedActions: 0,
      recordRevision: 1,
      updatedAt: now,
    });
    return { outcome: "ADMITTED", experiment: created };
  }

  async design(experimentId: string): Promise<{
    experiment: GovernedExperiment;
    plan: ExperimentPlan;
  }> {
    let experiment = await this.requireExperiment(experimentId);
    if (experiment.status === "ADMITTED") {
      experiment = await this.transition(experiment, "DESIGNING");
    } else if (experiment.status === "STALE") {
      experiment = await this.transition(experiment, "DESIGNING");
    } else if (experiment.status === "DESIGNING") {
      // continue
    } else if (experiment.status === "PLANNED" && experiment.experimentPlanHash) {
      const existing = await this.deps.plans.getByHash(
        experiment.experimentId,
        experiment.experimentPlanHash,
      );
      if (existing) {
        return { experiment, plan: existing };
      }
    } else {
      throw new ExperimentError(
        "EXPERIMENT_STATE_CONFLICT",
        `Cannot design from ${experiment.status}`,
      );
    }

    const proposal = await this.deps.designModel.design({ experiment });
    // Explicitly discard untrusted model risk suggestion — never authoritative.
    void proposal.untrustedSuggestedRiskClass;

    const now = this.deps.nowIso();
    const experimentPlanVersion =
      (experiment.experimentPlanVersion ?? INITIAL_EXPERIMENT_PLAN_VERSION - 1) +
      1;
    const assumptionBindings = fakeAssumptionBindingsFor(experiment);

    const plan = withExperimentPlanHash({
      experimentId: experiment.experimentId,
      experimentVersion: experiment.experimentVersion,
      experimentPlanVersion,
      hypotheses: proposal.hypotheses as ExperimentHypothesis[],
      measurements: proposal.measurements as ExperimentMeasurement[],
      procedure: proposal.procedure,
      requiredCapabilities: [],
      requestedActions: [],
      resourceEstimate: experiment.budgetEnvelope,
      riskAssessment: proposal.riskAssessment,
      riskClass: experiment.riskClass,
      stoppingRules: proposal.stoppingRules as ExperimentStoppingRule[],
      successRules: proposal.successRules,
      inconclusiveRules: proposal.inconclusiveRules,
      evidenceRequirements: proposal.evidenceRequirements,
      assumptionBindings,
      assignmentMethod: "NONE",
      policyBundleFingerprint: experiment.policyBundleFingerprint,
      capabilitySetFingerprint: experiment.capabilitySetFingerprint,
      projectConfigurationFingerprint:
        experiment.projectConfigurationFingerprint,
      designModelId: this.deps.designModel.modelId,
      designModelVersion: this.deps.designModel.modelVersion,
      createdAt: now,
    });

    await this.deps.plans.save(plan);
    await reserveExperimentUsage({
      usageLedger: this.deps.usageLedger,
      experimentId: experiment.experimentId,
      budget: experiment.budgetEnvelope,
      delta: { designCalls: 1, modelCalls: 1 },
      nowIso: now,
    });

    const planned = await this.deps.experiments.transition(
      experiment.experimentId,
      experiment.status,
      experiment.recordRevision,
      "PLANNED",
      now,
      {
        experimentPlanVersion: plan.experimentPlanVersion,
        experimentPlanHash: plan.experimentPlanHash,
        hypotheses: plan.hypotheses,
        measurements: plan.measurements,
        assumptionBindings: plan.assumptionBindings,
      },
    );

    return { experiment: planned, plan };
  }

  async validate(experimentId: string): Promise<{
    experiment: GovernedExperiment;
    plan: ExperimentPlan;
    validation: ReturnType<typeof validateExperimentPlan>;
  }> {
    let experiment = await this.requireExperiment(experimentId);
    if (experiment.status === "PLANNED") {
      experiment = await this.transition(experiment, "VALIDATING");
    } else if (experiment.status !== "VALIDATING") {
      throw new ExperimentError(
        "EXPERIMENT_STATE_CONFLICT",
        `Cannot validate from ${experiment.status}`,
      );
    }

    const plan = await this.requireLatestPlan(experiment);
    const validation = validateExperimentPlan({ experiment, plan });
    const now = this.deps.nowIso();

    if (validation.outcome === "BLOCK") {
      await this.deps.experiments.transition(
        experiment.experimentId,
        experiment.status,
        experiment.recordRevision,
        "DESIGNING",
        now,
        { failureReasonCode: "EXPERIMENT_PLAN_INVALID" },
      );
      throw new ExperimentError(
        "EXPERIMENT_PLAN_INVALID",
        validation.findings.map((f) => f.message).join("; "),
        { findings: validation.findings },
      );
    }

    assertValidExperimentPlan({ experiment, plan });
    const awaiting = await this.deps.experiments.transition(
      experiment.experimentId,
      experiment.status,
      experiment.recordRevision,
      "AWAITING_AUTHORIZATION",
      now,
    );
    return { experiment: awaiting, plan, validation };
  }

  async routeAuthorization(experimentId: string): Promise<{
    request: ExperimentAuthorizationRequest;
    decisionNonce: string;
  }> {
    const experiment = await this.requireExperiment(experimentId);
    if (experiment.status !== "AWAITING_AUTHORIZATION") {
      throw new ExperimentError(
        "EXPERIMENT_STATE_CONFLICT",
        "Authorization routing requires AWAITING_AUTHORIZATION",
      );
    }
    await this.recheckTruthOrMarkStale(experiment);

    const plan = await this.requireLatestPlan(experiment);
    const existing = await this.deps.authRequests.getPending(experimentId);
    if (existing) {
      const stored = await this.deps.authNonceStore?.take(
        existing.authorizationId,
      );
      if (stored) {
        await this.deps.authNonceStore?.put(existing.authorizationId, stored);
        return { request: existing, decisionNonce: stored };
      }
    }

    const now = this.deps.nowIso();
    const expiresAt = new Date(
      Date.parse(now) + 24 * 60 * 60 * 1000,
    ).toISOString();
    const budgetFp = budgetFingerprint(plan.resourceEstimate);
    const subjectHash = computeExperimentAuthSubjectHash({
      experimentId: experiment.experimentId,
      experimentVersion: experiment.experimentVersion,
      experimentPlanVersion: plan.experimentPlanVersion,
      experimentPlanHash: plan.experimentPlanHash,
      policyBundleFingerprint: plan.policyBundleFingerprint,
      capabilitySetFingerprint: plan.capabilitySetFingerprint,
      projectConfigurationFingerprint: plan.projectConfigurationFingerprint,
      budgetFingerprint: budgetFp,
      riskClass: experiment.riskClass,
      expiresAt,
    });
    const issued = issueDecisionNonce(this.deps.nonceGenerator);
    const authorizationId = mintExperimentAuthorizationId({
      experimentId: experiment.experimentId,
      experimentPlanHash: plan.experimentPlanHash,
    });
    const request: ExperimentAuthorizationRequest = {
      authorizationId,
      experimentId: experiment.experimentId,
      experimentVersion: experiment.experimentVersion,
      experimentPlanVersion: plan.experimentPlanVersion,
      experimentPlanHash: plan.experimentPlanHash,
      policyBundleFingerprint: plan.policyBundleFingerprint,
      capabilitySetFingerprint: plan.capabilitySetFingerprint,
      projectConfigurationFingerprint: plan.projectConfigurationFingerprint,
      budgetFingerprint: budgetFp,
      riskClass: experiment.riskClass,
      subjectHash,
      decisionNonceHash: issued.nonceHash,
      status: "PENDING",
      expiresAt,
      createdAt: now,
      recordRevision: 1,
    };
    const saved = await this.deps.authRequests.save(request);
    await this.deps.authNonceStore?.put(saved.authorizationId, issued.plaintext);
    return { request: saved, decisionNonce: issued.plaintext };
  }

  async decideAuthorization(input: {
    authorizationId: string;
    sponsorId: string;
    decision: ExperimentAuthorizationDecision;
    decisionNonce: string;
    submittedAt: string;
    institutionalProofId?: string;
  }): Promise<{
    request: ExperimentAuthorizationRequest;
    record?: ExperimentAuthorizationRecord;
    experiment: GovernedExperiment;
  }> {
    const request = await this.deps.authRequests.getById(input.authorizationId);
    if (!request || request.status !== "PENDING") {
      throw new ExperimentError(
        "EXPERIMENT_AUTHORIZATION_INVALID",
        "No pending experiment authorization request",
      );
    }
    if (Date.parse(input.submittedAt) > Date.parse(request.expiresAt)) {
      await this.deps.authRequests.saveCas(
        { ...request, status: "EXPIRED" },
        request.recordRevision,
      );
      throw new ExperimentError(
        "EXPERIMENT_AUTHORIZATION_EXPIRED",
        "Experiment authorization request expired",
      );
    }
    if (hashDecisionNonce(input.decisionNonce) !== request.decisionNonceHash) {
      throw new ExperimentError(
        "EXPERIMENT_AUTHORIZATION_INVALID",
        "Decision nonce mismatch",
      );
    }

    const experiment = await this.requireExperiment(request.experimentId);
    if (input.decision === "APPROVE_EXPERIMENT") {
      await assertInstitutionalRequirements({
        port: this.deps.institutionalGovernance,
        requiredRole: "EXPERIMENT_SPONSOR",
        projectId: experiment.projectId,
        environment: experiment.requestedEnvironment,
        subjectClass: "EXPERIMENT_AUTHORIZATION",
        subjectType: "EXPERIMENT_AUTHORIZATION",
        subjectId: experiment.experimentId,
        subjectHash: request.subjectHash,
        ...(input.institutionalProofId !== undefined
          ? { institutionalProofId: input.institutionalProofId }
          : {}),
        atIso: input.submittedAt,
      });
    }

    if (!this.deps.isExperimentSponsor) {
      throw new ExperimentError(
        "EXPERIMENT_AUTHORIZATION_INVALID",
        "EXPERIMENT_SPONSOR authority check not configured",
      );
    }
    const allowed = await this.deps.isExperimentSponsor(input.sponsorId, [
      experiment.projectId,
    ]);
    if (!allowed) {
      throw new ExperimentError(
        "EXPERIMENT_SPONSOR_SCOPE_INSUFFICIENT",
        "Principal lacks explicit EXPERIMENT_SPONSOR for experiment project",
        {
          sponsorId: input.sponsorId,
          requiredProjects: [experiment.projectId],
        },
      );
    }

    await this.recheckTruthOrMarkStale(experiment);

    const decided = await this.deps.authRequests.saveCas(
      {
        ...request,
        status: "DECIDED",
        sponsorId: input.sponsorId,
        decision: input.decision,
        decidedAt: input.submittedAt,
      },
      request.recordRevision,
    );

    if (input.decision === "REQUEST_REVISION") {
      const revised = await this.transition(experiment, "DESIGNING");
      return { request: decided, experiment: revised };
    }
    if (input.decision === "REJECT_EXPERIMENT") {
      const cancelled = await this.transition(experiment, "CANCELLED");
      return { request: decided, experiment: cancelled };
    }

    const record: ExperimentAuthorizationRecord = {
      authorizationRecordId: mintExperimentAuthorizationRecordId({
        authorizationId: request.authorizationId,
        decidedAt: input.submittedAt,
      }),
      authorizationId: request.authorizationId,
      experimentId: experiment.experimentId,
      experimentVersion: experiment.experimentVersion,
      experimentPlanVersion: request.experimentPlanVersion,
      experimentPlanHash: request.experimentPlanHash,
      sponsorId: input.sponsorId,
      decision: input.decision,
      subjectHash: request.subjectHash,
      decisionNonceHash: request.decisionNonceHash,
      decidedAt: input.submittedAt,
      expiresAt: request.expiresAt,
      createdAt: input.submittedAt,
    };
    await this.deps.authRecords.save(record);
    const authorized = await this.transition(experiment, "AUTHORIZED");
    return { request: decided, record, experiment: authorized };
  }

  async compileExecution(experimentId: string): Promise<{
    experiment: GovernedExperiment;
    compiled: CompiledExperimentObjective;
    lineage: ExperimentExecutionLineage;
  }> {
    assertExperimentAuthorizationDoesNotExecute();

    const experiment = await this.requireExperiment(experimentId);
    if (experiment.status === "AWAITING_EXECUTION_AUTHORIZATION") {
      const existing = await this.deps.lineage.listByExperiment(experimentId);
      const lineage = existing[0];
      if (!lineage?.compiledRunId) {
        throw new ExperimentError(
          "EXECUTION_COMPILATION_FAILED",
          "AWAITING_EXECUTION_AUTHORIZATION without durable Phase 2 lineage",
        );
      }
      const plan = await this.requireLatestPlan(experiment);
      const auth = await this.deps.authRecords.getLatest(experimentId);
      if (!auth) {
        throw new ExperimentError(
          "EXPERIMENT_AUTHORIZATION_REQUIRED",
          "No experiment authorization record",
        );
      }
      const { compiled } = compileExperimentToObjective({
        experiment,
        plan,
        authorization: auth,
        compiledAt: this.deps.nowIso(),
      });
      return { experiment, compiled, lineage };
    }

    if (experiment.status !== "AUTHORIZED") {
      throw new ExperimentError(
        "EXPERIMENT_STATE_CONFLICT",
        "Execution compilation requires AUTHORIZED",
      );
    }
    await this.recheckTruthOrMarkStale(experiment);

    const plan = await this.requireLatestPlan(experiment);
    const authorization = await this.deps.authRecords.getLatest(experimentId);
    if (!authorization || authorization.decision !== "APPROVE_EXPERIMENT") {
      throw new ExperimentError(
        "EXPERIMENT_AUTHORIZATION_REQUIRED",
        "APPROVE_EXPERIMENT record required before compilation",
      );
    }

    assertExperimentAuthorizationDoesNotExecute();
    const { compiled, lineageDraft } = compileExperimentToObjective({
      experiment,
      plan,
      authorization,
      compiledAt: this.deps.nowIso(),
    });

    // Crash recovery: lineage already persisted with admitted run — transition once.
    const priorLineages = await this.deps.lineage.listByExperiment(experimentId);
    const prior = priorLineages.find(
      (l) => l.lineageId === lineageDraft.lineageId && l.compiledRunId,
    );
    if (prior) {
      if (prior.phase6AuthorizationRecordId || prior.executionAttemptId) {
        throw new ExperimentError(
          "EXPERIMENT_AUTH_DOES_NOT_EXECUTE",
          "Compilation must not create Phase 6 auth or execution attempts",
        );
      }
      const awaiting = await this.transition(
        experiment,
        "AWAITING_EXECUTION_AUTHORIZATION",
      );
      return { experiment: awaiting, compiled, lineage: prior };
    }

    if (!this.deps.objectiveAdmissionPort) {
      throw new ExperimentError(
        "OBJECTIVE_ADMISSION_UNAVAILABLE",
        "Phase 2 ExperimentObjectiveAdmissionPort is not configured — experiment remains AUTHORIZED",
      );
    }

    // Reserve action budget before Phase 2 admit (reuse does not double-charge).
    const ledger = await this.deps.usageLedger.get(experimentId);
    const alreadyReserved =
      (ledger?.reservedActions ?? 0) + (ledger?.committedActions ?? 0) > 0;
    if (!alreadyReserved) {
      await reserveExperimentUsage({
        usageLedger: this.deps.usageLedger,
        experimentId,
        budget: experiment.budgetEnvelope,
        delta: { reservedActions: 1 },
        nowIso: this.deps.nowIso(),
      });
    }

    const admission = await this.deps.objectiveAdmissionPort.admitCompiledObjective(
      {
        experiment,
        plan,
        authorization,
        compiled,
        objectiveId: compiled.objectiveId,
        objectiveVersion: compiled.objectiveVersion,
        requesterId: experiment.createdBy,
        submittedAt: this.deps.nowIso(),
      },
    );

    if (admission.outcome === "UNAVAILABLE") {
      throw new ExperimentError(
        "OBJECTIVE_ADMISSION_UNAVAILABLE",
        admission.reason,
      );
    }
    if (admission.outcome === "REJECTED") {
      throw new ExperimentError(
        "OBJECTIVE_ADMISSION_REJECTED",
        admission.reason,
      );
    }

    if (this.deps.compileFailpoint?.afterAdmit) {
      await this.deps.compileFailpoint.afterAdmit();
    }

    const now = this.deps.nowIso();
    const lineage: ExperimentExecutionLineage = {
      ...lineageDraft,
      compiledObjectiveId: admission.objectiveId,
      compiledObjectiveVersion: admission.objectiveVersion,
      compiledRunId: admission.runId,
      phase2AdmissionOutcome:
        admission.outcome === "ADMITTED" ? "ADMITTED" : "DUPLICATE_REUSED",
      updatedAt: now,
    };

    if (lineage.phase6AuthorizationRecordId || lineage.executionAttemptId) {
      throw new ExperimentError(
        "EXPERIMENT_AUTH_DOES_NOT_EXECUTE",
        "Compilation must not create Phase 6 auth or execution attempts",
      );
    }

    await this.deps.lineage.save(lineage);

    // Settle reservation → committed (idempotent for DUPLICATE_REUSED retries).
    const afterAdmitLedger = await this.deps.usageLedger.get(experimentId);
    if (afterAdmitLedger && afterAdmitLedger.reservedActions > 0) {
      await reserveExperimentUsage({
        usageLedger: this.deps.usageLedger,
        experimentId,
        budget: experiment.budgetEnvelope,
        delta: { reservedActions: -1, committedActions: 1 },
        nowIso: now,
      });
    } else if (
      afterAdmitLedger &&
      afterAdmitLedger.committedActions === 0 &&
      admission.outcome === "DUPLICATE_REUSED"
    ) {
      // Retry after crash where reservation already settled or never reserved.
      await reserveExperimentUsage({
        usageLedger: this.deps.usageLedger,
        experimentId,
        budget: experiment.budgetEnvelope,
        delta: { committedActions: 1 },
        nowIso: now,
      });
    }

    if (this.deps.compileFailpoint?.afterLineage) {
      await this.deps.compileFailpoint.afterLineage();
    }

    const awaiting = await this.transition(
      experiment,
      "AWAITING_EXECUTION_AUTHORIZATION",
    );
    return { experiment: awaiting, compiled, lineage };
  }

  async recordVerifiedMeasurements(
    experimentId: string,
    measurementResults: MeasurementResult[],
  ): Promise<{
    experiment: GovernedExperiment;
    result: ExperimentResult;
  }> {
    let experiment = await this.requireExperiment(experimentId);
    if (
      experiment.status !== "EXECUTING" &&
      experiment.status !== "VERIFYING"
    ) {
      throw new ExperimentError(
        "EXPERIMENT_STATE_CONFLICT",
        `Cannot record measurements from ${experiment.status}`,
      );
    }
    if (experiment.status === "EXECUTING") {
      experiment = await this.transition(experiment, "VERIFYING");
    }

    const plan = await this.requireLatestPlan(experiment);
    const existingResultId = mintExperimentResultId({
      experimentId: experiment.experimentId,
      experimentPlanHash: plan.experimentPlanHash,
    });
    const existing = await this.deps.results.getById(existingResultId);
    const deltaSamples = sampleCountDelta({
      existing: existing?.measurementResults ?? [],
      incoming: measurementResults,
    });
    const result = await this.mergeMeasurementResults(
      experiment,
      plan,
      measurementResults,
    );
    if (deltaSamples > 0) {
      await reserveExperimentUsage({
        usageLedger: this.deps.usageLedger,
        experimentId: experiment.experimentId,
        budget: experiment.budgetEnvelope,
        delta: { sampleCount: deltaSamples },
        nowIso: this.deps.nowIso(),
      });
    }
    return { experiment, result };
  }

  async verifyAndComplete(
    experimentId: string,
    opts?: {
      measurementResults?: MeasurementResult[];
      /** Resolved through ExperimentOutcomeVerificationPort — never trusted as opaque strings. */
      outcomeVerificationIds?: string[];
    },
  ): Promise<{
    experiment: GovernedExperiment;
    result: ExperimentResult;
    evidenceBundle: ExperimentEvidenceBundle;
    updateCandidates: AssumptionEvidenceUpdateCandidate[];
    completion: ExperimentCompletionRecord;
  }> {
    let experiment = await this.requireExperiment(experimentId);
    if (
      experiment.status === "COMPLETED" ||
      experiment.status === "INCONCLUSIVE"
    ) {
      const completion = await this.deps.completions.getByExperiment(
        experimentId,
      );
      const evidenceBundle =
        await this.deps.evidenceBundles.getByExperiment(experimentId);
      const results = await this.deps.results.listByExperiment(experimentId);
      const updateCandidates =
        await this.deps.updateCandidates.listByExperiment(experimentId);
      if (!completion || !evidenceBundle || results.length === 0) {
        throw new ExperimentError(
          "EVIDENCE_BUNDLE_INVALID",
          "Terminal experiment missing durable completion artifacts",
        );
      }
      return {
        experiment,
        result: results[results.length - 1]!,
        evidenceBundle,
        updateCandidates: [...updateCandidates],
        completion,
      };
    }
    if (
      experiment.status !== "EXECUTING" &&
      experiment.status !== "VERIFYING"
    ) {
      throw new ExperimentError(
        "EXPERIMENT_STATE_CONFLICT",
        `Cannot verify/complete from ${experiment.status}`,
      );
    }
    if (experiment.status === "EXECUTING") {
      experiment = await this.transition(experiment, "VERIFYING");
    }

    await this.recheckTruthOrMarkStale(experiment);

    const plan = await this.requireLatestPlan(experiment);
    const measurementResults = opts?.measurementResults ?? [];
    const existingResultId = mintExperimentResultId({
      experimentId: experiment.experimentId,
      experimentPlanHash: plan.experimentPlanHash,
    });
    const existing = await this.deps.results.getById(existingResultId);
    const deltaSamples = sampleCountDelta({
      existing: existing?.measurementResults ?? [],
      incoming: measurementResults,
    });
    const provisional = await this.mergeMeasurementResults(
      experiment,
      plan,
      measurementResults,
    );
    if (deltaSamples > 0) {
      await reserveExperimentUsage({
        usageLedger: this.deps.usageLedger,
        experimentId: experiment.experimentId,
        budget: experiment.budgetEnvelope,
        delta: { sampleCount: deltaSamples },
        nowIso: this.deps.nowIso(),
      });
    }

    const lineages = await this.deps.lineage.listByExperiment(experimentId);
    const lineage = lineages[0] ?? null;
    const executionLineageId = lineage?.lineageId;

    const requestedVerificationIds = opts?.outcomeVerificationIds ?? [];
    if (!this.deps.outcomeVerificationPort) {
      if (requestedVerificationIds.length > 0) {
        throw new ExperimentError(
          "PHASE8_VERIFICATION_REQUIRED",
          "Phase 8 ExperimentOutcomeVerificationPort is not configured",
        );
      }
    }

    const runProjectId =
      lineage?.compiledRunId && this.deps.resolveRunProjectId
        ? await this.deps.resolveRunProjectId(lineage.compiledRunId)
        : undefined;

    const phase8Bindings =
      this.deps.outcomeVerificationPort && requestedVerificationIds.length > 0
        ? await resolveBoundPhase8Verifications({
            verificationPort: this.deps.outcomeVerificationPort,
            outcomeVerificationIds: requestedVerificationIds,
            lineage,
            experimentProjectId: experiment.projectId,
            ...(runProjectId !== undefined && runProjectId !== null
              ? { expectedRunProjectId: runProjectId }
              : {}),
          })
        : [];

    // Authoritative quality is derived from Phase 8 — never from measurement.quality.
    const authoritativeQuality =
      phase8Bindings.length > 0
        ? worstAuthoritativeQuality(phase8Bindings)
        : ("UNKNOWN" as const);
    const conclusivePhase8 = phase8AllowsConclusiveHypothesis(phase8Bindings);

    const hypothesisResults = resolveHypothesisOutcomes({
      hypotheses: plan.hypotheses,
      measurementResults: provisional.measurementResults,
      authoritativeQuality,
      conclusivePhase8,
    });

    const allInconclusive = hypothesisResults.every(
      (h) => h.outcome === "INCONCLUSIVE",
    );
    const terminalStatus = allInconclusive ? "INCONCLUSIVE" : "COMPLETED";
    const now = this.deps.nowIso();
    const outcomeVerificationIds = phase8Bindings.map(
      (b) => b.record.outcomeVerificationId,
    );

    const result: ExperimentResult = {
      ...provisional,
      hypothesisResults,
      evidenceRefs: [
        ...new Set([
          ...provisional.evidenceRefs,
          ...phase8Bindings.flatMap((b) => b.record.evidenceRefs),
        ]),
      ],
      dataQuality: authoritativeQuality,
      limitations: [
        ...provisional.limitations,
        "Measurement quality fields are untrusted DATA only",
        "AssumptionEvidenceUpdateCandidate never mutates AssumptionSets in place",
        ...(phase8Bindings.length === 0
          ? [
              "No Phase 8 verification binding — evidence is INCONCLUSIVE / insufficient",
            ]
          : []),
      ],
      stoppingReason:
        terminalStatus === "INCONCLUSIVE"
          ? "INCONCLUSIVE"
          : "MINIMUM_EVIDENCE",
      ...(executionLineageId ? { executionLineageId } : {}),
      outcomeVerificationIds,
      hypothesisCount: plan.hypotheses.length,
      correctionPolicy:
        plan.hypotheses.length > 1
          ? "MULTIPLE_TESTING_UNADJUSTED"
          : "NONE",
      createdAt: provisional.createdAt,
    };

    const evidenceBundle = withEvidenceBundleHash({
      evidenceBundleId: mintEvidenceBundleId({
        experimentId: experiment.experimentId,
        experimentResultId: result.experimentResultId,
      }),
      experimentId: experiment.experimentId,
      experimentVersion: experiment.experimentVersion,
      experimentPlanHash: plan.experimentPlanHash,
      experimentResultId: result.experimentResultId,
      verifiedMeasurementEvidence: [...result.measurementResults],
      qualityClassification: authoritativeQuality,
      artifactRefs: result.evidenceRefs,
      outcomeVerificationIds,
      verificationRefs: outcomeVerificationIds,
      hypothesisOutcomeRefs: hypothesisResults.map(
        (h) => `${h.hypothesisId}:${h.outcome}`,
      ),
      assumptionBindings: plan.assumptionBindings.map((b) => b.assumptionId),
      limitations: result.limitations,
      createdAt: now,
    });

    const updateCandidates: AssumptionEvidenceUpdateCandidate[] = [];
    for (const binding of plan.assumptionBindings) {
      const hyp =
        hypothesisResults.find((h) => h.hypothesisId === binding.hypothesisId) ??
        hypothesisResults[0];
      if (!hyp) continue;
      updateCandidates.push(
        buildAssumptionUpdateCandidate({
          experiment,
          plan,
          binding,
          evidenceBundle,
          hypothesisOutcome: hyp,
          ...(result.measurementResults[0]
            ? { primaryMeasurement: result.measurementResults[0] }
            : {}),
          outcomeVerificationIds,
          createdAt: now,
        }),
      );
    }

    return withOptionalTransaction(this.deps.transactions, async () => {
      await this.deps.results.save(result);
      await this.deps.evidenceBundles.save(evidenceBundle);

      if (this.deps.completionFailpoint?.afterEvidence) {
        await this.deps.completionFailpoint.afterEvidence();
      }

      for (const candidate of updateCandidates) {
        await this.deps.updateCandidates.save(candidate);
      }

      const completion: ExperimentCompletionRecord = {
        completionRecordId: mintCompletionRecordId({
          experimentId: experiment.experimentId,
          evidenceBundleId: evidenceBundle.evidenceBundleId,
        }),
        experimentId: experiment.experimentId,
        experimentVersion: experiment.experimentVersion,
        experimentPlanHash: plan.experimentPlanHash,
        ...(executionLineageId ? { executionLineageId } : {}),
        evidenceBundleId: evidenceBundle.evidenceBundleId,
        evidenceBundleHash: evidenceBundle.evidenceBundleHash,
        experimentResultId: result.experimentResultId,
        outcomeVerificationIds,
        terminalStatus,
        createdAt: now,
      };
      await this.deps.completions.save(completion);

      const completed = await this.deps.experiments.transition(
        experiment.experimentId,
        experiment.status,
        experiment.recordRevision,
        terminalStatus,
        now,
      );

      return {
        experiment: completed,
        result,
        evidenceBundle,
        updateCandidates,
        completion,
      };
    });
  }

  async markStale(experimentId: string): Promise<GovernedExperiment> {
    const experiment = await this.requireExperiment(experimentId);
    if (
      experiment.status === "COMPLETED" ||
      experiment.status === "INCONCLUSIVE" ||
      experiment.status === "FAILED" ||
      experiment.status === "CANCELLED"
    ) {
      throw new ExperimentError(
        "EXPERIMENT_STATE_CONFLICT",
        `Cannot mark stale from terminal state ${experiment.status}`,
      );
    }
    return this.transition(experiment, "STALE", {
      failureReasonCode: "TRUTH_DRIFT",
    });
  }

  async recheckTruthOrMarkStale(experiment: GovernedExperiment): Promise<void> {
    const current = await this.buildTruthSnapshot(
      experiment.projectId,
      experiment.requestedEnvironment,
    );
    if (
      experiment.truthSnapshotFingerprint &&
      current.truthSnapshotFingerprint !== experiment.truthSnapshotFingerprint
    ) {
      await this.markStale(experiment.experimentId);
      throw new ExperimentError(
        "PACKAGE_STALE",
        "Truth snapshot drifted — experiment marked STALE; re-design required",
        { reasonCode: "TRUTH_DRIFT" },
      );
    }
  }

  private async buildTruthSnapshot(
    projectId: string,
    environment: string,
  ): Promise<{
    truthSnapshotFingerprint: string;
    policyBundleFingerprint: string;
    capabilitySetFingerprint: string;
    projectConfigurationFingerprint: string;
  }> {
    const context = await this.deps.controlPlane.resolve(projectId, environment);
    const caps = context.availableCapabilities.map((c) => ({
      capabilityId: c.capabilityId,
      version: c.version,
      enabled: c.enabled,
      allowedActions: c.allowedActions,
      forbiddenActions: c.forbiddenActions,
      allowedEnvironments: c.allowedEnvironments,
      approvalRequirement: c.approvalRequirement,
      maximumRuntimeSeconds: c.maximumRuntimeSeconds,
    }));
    const policyBundleFingerprint = context.activePolicyBundle.policyHash;
    const capFp = capabilitySetFingerprint(caps);
    const projFp = projectConfigurationFingerprint({
      projectId,
      activePolicyBundleId: context.project.activePolicyBundleId,
      budgetProfileId: context.project.resourceBudgetProfileId,
      allowedEnvironments: context.project.allowedEnvironments,
      executionMode: context.project.executionMode,
    });
    // Fingerprint excludes resolvedAt — wall-clock must not cause TRUTH_DRIFT.
    const truthSnapshotFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          capabilitySetFingerprint: capFp,
          policyBundleFingerprint,
          projectConfigurationFingerprint: projFp,
        }),
        "utf8",
      )
      .digest("hex");

    return {
      truthSnapshotFingerprint,
      policyBundleFingerprint,
      capabilitySetFingerprint: capFp,
      projectConfigurationFingerprint: projFp,
    };
  }

  private async mergeMeasurementResults(
    experiment: GovernedExperiment,
    plan: ExperimentPlan,
    incoming: MeasurementResult[],
  ): Promise<ExperimentResult> {
    const resultId = mintExperimentResultId({
      experimentId: experiment.experimentId,
      experimentPlanHash: plan.experimentPlanHash,
    });
    const existing = await this.deps.results.getById(resultId);
    const byMeasurement = new Map<string, MeasurementResult>();
    for (const m of existing?.measurementResults ?? []) {
      byMeasurement.set(m.measurementId, m);
    }
    for (const m of incoming) {
      byMeasurement.set(m.measurementId, m);
    }
    const measurementResults = [...byMeasurement.values()];
    const now = this.deps.nowIso();
    const result: ExperimentResult = {
      experimentResultId: resultId,
      experimentId: experiment.experimentId,
      experimentVersion: experiment.experimentVersion,
      experimentPlanVersion: plan.experimentPlanVersion,
      experimentPlanHash: plan.experimentPlanHash,
      measurementResults,
      hypothesisResults: existing?.hypothesisResults ?? [],
      evidenceRefs: [
        ...new Set([
          ...(existing?.evidenceRefs ?? []),
          ...measurementResults.flatMap((m) => m.evidenceRefs),
        ]),
      ],
      dataQuality: existing?.dataQuality ?? "UNKNOWN",
      limitations: existing?.limitations ?? [],
      stoppingReason: existing?.stoppingReason ?? "IN_PROGRESS",
      outcomeVerificationIds: existing?.outcomeVerificationIds ?? [],
      hypothesisCount: plan.hypotheses.length,
      correctionPolicy:
        plan.hypotheses.length > 1
          ? "MULTIPLE_TESTING_UNADJUSTED"
          : "NONE",
      createdAt: existing?.createdAt ?? now,
    };
    await this.deps.results.save(result);
    return result;
  }

  private async requireExperiment(
    experimentId: string,
  ): Promise<GovernedExperiment> {
    const experiment = await this.deps.experiments.getById(experimentId);
    if (!experiment) {
      throw new ExperimentError(
        "EXPERIMENT_NOT_FOUND",
        `Experiment ${experimentId} missing`,
      );
    }
    return experiment;
  }

  private async requireLatestPlan(
    experiment: GovernedExperiment,
  ): Promise<ExperimentPlan> {
    const plan = await this.deps.plans.getLatest(experiment.experimentId);
    if (!plan) {
      throw new ExperimentError(
        "EXPERIMENT_PLAN_INVALID",
        "Experiment plan missing",
      );
    }
    return plan;
  }

  private async transition(
    experiment: GovernedExperiment,
    next: GovernedExperiment["status"],
    patch: Partial<GovernedExperiment> = {},
  ): Promise<GovernedExperiment> {
    assertExperimentTransition(experiment.status, next);
    return withOptionalTransaction(this.deps.transactions, async () =>
      this.deps.experiments.transition(
        experiment.experimentId,
        experiment.status,
        experiment.recordRevision,
        next,
        this.deps.nowIso(),
        patch,
      ),
    );
  }
}
