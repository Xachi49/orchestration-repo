import { randomUUID } from "node:crypto";
import type { RunRepository } from "../admission/run-repository.js";
import type { ObjectiveRepository } from "../admission/objective-repository.js";
import type {
  ControlPlaneClock,
  ControlPlaneService,
} from "../control-plane/service.js";
import type { ProjectControlContext } from "../control-plane/context.js";
import type { CapabilityRegistry } from "../control-plane/capabilities/registry.js";
import type { ResourceBudgetProfile } from "../control-plane/budgets/budget.js";
import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import type {
  ValidationDecision,
  ValidationDecisionClass,
  ValidationFinding,
} from "../domain/validation/index.js";
import { parseValidationDecision } from "../domain/validation/index.js";
import type {
  EvidenceRegistry,
  LockedRepositoryStore,
  RepositoryWorkspaceService,
  VerifiedRepositoryContextStore,
} from "../ingestion/index.js";
import type { CommitSha } from "../ingestion/remote-repository.js";
import type { LockedRepositoryState } from "../ingestion/locked-state.js";
import type { VerifiedRepositoryContext } from "../ingestion/context.js";
import { ContextBudgetController } from "../planning/budget-controller.js";
import { CapabilityReferenceValidator } from "../planning/capability-ref-validator.js";
import { EvidenceReferenceValidator } from "../planning/evidence-ref-validator.js";
import { DependencyGraphService } from "../planning/dependency-graph.js";
import { PlanResourceAnalyzer } from "../planning/resource-analyzer.js";
import { PlanQualityScorer } from "../planning/quality-scorer.js";
import { PlanCompiler, type PlanIdentityGenerator } from "../planning/plan-compiler.js";
import { PLANNING_PROMPT_VERSION } from "../planning/context.js";
import type { PlanningContext } from "../planning/context.js";
import type {
  PlanRepository,
  StoredPlanRecord,
  StoredPlanStatus,
} from "../planning/plan-repository.js";
import { isPlanningError } from "../planning/errors.js";
import {
  ValidationError,
  isValidationError,
  isValidationPreDispatchError,
} from "./errors.js";
import {
  ValidationReadinessService,
  type ValidationReadinessResult,
} from "./readiness.js";
import {
  validationFenceKey,
  type ValidationCoordinator,
  type ValidationFenceKey,
} from "./coordinator.js";
import { DeterministicValidationService } from "./deterministic.js";
import { ValidationDecisionEngine, type ValidationReasonCode } from "./decision-engine.js";
import type { ValidationDecisionRepository } from "./decision-repository.js";
import { ValidationFindingFactory } from "./finding-factory.js";
import { ViolationFingerprintService } from "./fingerprint.js";
import { ValidationInferenceBudget } from "./inference-budget.js";
import {
  ValidationPromptAssembler,
  type AssembledValidationPrompt,
} from "./prompt-assembler.js";
import { RevisionPromptAssembler } from "./revision-prompt-assembler.js";
import { RevisionEnvelopeBuilder } from "./revision-envelope.js";
import type { PlanRevisionModel } from "./revision-model.js";
import {
  createPlanningException,
  type PlanningException,
  type PlanningExceptionType,
} from "./exception.js";
import {
  ByteLengthValidationTokenEstimator,
  DEFAULT_VALIDATION_MAX_OUTPUT_TOKENS,
  type AssembledValidationPromptLike,
  type ValidationMaxOutputTokensByOperation,
  type ValidationTokenReservationEstimator,
} from "./token-reservation.js";
import {
  resolveValidationChargedTokenTotal,
  type ContextualValidationAssessment,
  type ValidationModel,
  type ValidationModelOperation,
  type ValidationModelTokenUsage,
  type ValidationUsageLedger,
} from "./model.js";
import type { ValidationResult } from "./result.js";

/** Bounded semantic revision budget: v1 → v2 → v3. There is no v4. */
export const MAX_SEMANTIC_REVISION_ATTEMPTS = 2;

/** Highest plan version reachable through automated revision. */
export const MAX_REVISED_PLAN_VERSION = MAX_SEMANTIC_REVISION_ATTEMPTS + 1;

export const VALIDATOR_ID = "validator_phase5_v1";

export interface ValidationIdentityGenerator {
  nextValidationDecisionId(): string;
  nextRevisionEnvelopeId(): string;
  nextExceptionId(): string;
}

export class SequenceValidationIdentityGenerator
  implements ValidationIdentityGenerator
{
  private decisions = 0;
  private envelopes = 0;
  private exceptions = 0;

  nextValidationDecisionId(): string {
    this.decisions += 1;
    return `vd_${this.decisions}`;
  }

  nextRevisionEnvelopeId(): string {
    this.envelopes += 1;
    return `rev_${this.envelopes}`;
  }

  nextExceptionId(): string {
    this.exceptions += 1;
    return `pex_${this.exceptions}`;
  }
}

export interface ValidationServiceDeps {
  readiness: ValidationReadinessService;
  coordinator: ValidationCoordinator;
  runs: RunRepository;
  objectives: ObjectiveRepository;
  controlPlane: ControlPlaneService;
  contexts: VerifiedRepositoryContextStore;
  locks: LockedRepositoryStore;
  evidence: EvidenceRegistry;
  workspace: RepositoryWorkspaceService;
  plans: PlanRepository;
  capabilities: CapabilityRegistry;
  decisions: ValidationDecisionRepository;
  model: ValidationModel;
  usage: ValidationUsageLedger;
  revisionModel: PlanRevisionModel;
  planIdentities: PlanIdentityGenerator;
  identities: ValidationIdentityGenerator;
  clock: ControlPlaneClock;
  deterministic?: DeterministicValidationService;
  decisionEngine?: ValidationDecisionEngine;
  fingerprints?: ViolationFingerprintService;
  findings?: ValidationFindingFactory;
  prompts?: ValidationPromptAssembler;
  revisionPrompts?: RevisionPromptAssembler;
  envelopes?: RevisionEnvelopeBuilder;
  contextCompiler?: ContextBudgetController;
  evidenceRefs?: EvidenceReferenceValidator;
  capabilityRefs?: CapabilityReferenceValidator;
  dependencies?: DependencyGraphService;
  resources?: PlanResourceAnalyzer;
  quality?: PlanQualityScorer;
  compiler?: PlanCompiler;
  inferenceBudget?: ValidationInferenceBudget;
  tokenEstimator?: ValidationTokenReservationEstimator;
  maxOutputTokensByOperation?: ValidationMaxOutputTokensByOperation;
  maxRevisionAttempts?: number;
}

interface ValidationRunContext {
  projectId: string;
  environment: string;
  control: ProjectControlContext;
  repositoryContext: VerifiedRepositoryContext | null;
  liveLock: LockedRepositoryState | null;
}

/**
 * Phase 5 validation application service.
 *
 * Independent adjudication of a candidate plan: deterministic validators
 * establish what is true, an optional contextual model contributes advisory
 * observations, and a deterministic decision engine assigns the decision class.
 *
 * The run stays in VALIDATING throughout. PASS means "no objection found", not
 * "approved" — Phase 5 holds no approval or execution authority.
 */
export class ValidationService {
  private readonly readiness: ValidationReadinessService;
  private readonly coordinator: ValidationCoordinator;
  private readonly runs: RunRepository;
  private readonly objectives: ObjectiveRepository;
  private readonly controlPlane: ControlPlaneService;
  private readonly contexts: VerifiedRepositoryContextStore;
  private readonly locks: LockedRepositoryStore;
  private readonly evidence: EvidenceRegistry;
  private readonly workspace: RepositoryWorkspaceService;
  private readonly plans: PlanRepository;
  private readonly decisions: ValidationDecisionRepository;
  private readonly model: ValidationModel;
  private readonly usage: ValidationUsageLedger;
  private readonly revisionModel: PlanRevisionModel;
  private readonly identities: ValidationIdentityGenerator;
  private readonly clock: ControlPlaneClock;
  private readonly deterministic: DeterministicValidationService;
  private readonly decisionEngine: ValidationDecisionEngine;
  private readonly fingerprints: ViolationFingerprintService;
  private readonly findings: ValidationFindingFactory;
  private readonly prompts: ValidationPromptAssembler;
  private readonly revisionPrompts: RevisionPromptAssembler;
  private readonly envelopes: RevisionEnvelopeBuilder;
  private readonly contextCompiler: ContextBudgetController;
  private readonly evidenceRefs: EvidenceReferenceValidator;
  private readonly capabilityRefs: CapabilityReferenceValidator;
  private readonly dependencies: DependencyGraphService;
  private readonly resources: PlanResourceAnalyzer;
  private readonly quality: PlanQualityScorer;
  private readonly compiler: PlanCompiler;
  private readonly inferenceBudget: ValidationInferenceBudget;
  private readonly tokenEstimator: ValidationTokenReservationEstimator;
  private readonly maxOutputTokensByOperation: ValidationMaxOutputTokensByOperation;
  private readonly maxRevisionAttempts: number;

  constructor(deps: ValidationServiceDeps) {
    this.readiness = deps.readiness;
    this.coordinator = deps.coordinator;
    this.runs = deps.runs;
    this.objectives = deps.objectives;
    this.controlPlane = deps.controlPlane;
    this.contexts = deps.contexts;
    this.locks = deps.locks;
    this.evidence = deps.evidence;
    this.workspace = deps.workspace;
    this.plans = deps.plans;
    this.decisions = deps.decisions;
    this.model = deps.model;
    this.usage = deps.usage;
    this.revisionModel = deps.revisionModel;
    this.identities = deps.identities;
    this.clock = deps.clock;
    this.findings = deps.findings ?? new ValidationFindingFactory();
    this.deterministic =
      deps.deterministic ??
      new DeterministicValidationService({
        capabilities: deps.capabilities,
        findings: this.findings,
      });
    this.decisionEngine = deps.decisionEngine ?? new ValidationDecisionEngine();
    this.fingerprints = deps.fingerprints ?? new ViolationFingerprintService();
    this.prompts = deps.prompts ?? new ValidationPromptAssembler();
    this.revisionPrompts = deps.revisionPrompts ?? new RevisionPromptAssembler();
    this.envelopes = deps.envelopes ?? new RevisionEnvelopeBuilder();
    this.contextCompiler = deps.contextCompiler ?? new ContextBudgetController();
    this.evidenceRefs = deps.evidenceRefs ?? new EvidenceReferenceValidator();
    this.capabilityRefs =
      deps.capabilityRefs ??
      new CapabilityReferenceValidator(deps.capabilities);
    this.dependencies = deps.dependencies ?? new DependencyGraphService();
    this.resources = deps.resources ?? new PlanResourceAnalyzer();
    this.quality = deps.quality ?? new PlanQualityScorer();
    this.compiler = deps.compiler ?? new PlanCompiler(deps.planIdentities);
    this.inferenceBudget =
      deps.inferenceBudget ?? new ValidationInferenceBudget(deps.usage);
    this.tokenEstimator =
      deps.tokenEstimator ?? new ByteLengthValidationTokenEstimator();
    this.maxOutputTokensByOperation = {
      ...DEFAULT_VALIDATION_MAX_OUTPUT_TOKENS,
      ...deps.maxOutputTokensByOperation,
    };
    this.maxRevisionAttempts =
      deps.maxRevisionAttempts ?? MAX_SEMANTIC_REVISION_ATTEMPTS;
  }

  async validate(runId: string): Promise<ValidationResult> {
    const settled = await this.settledResult(runId);
    if (settled) {
      return settled;
    }

    let record = await this.readiness.assertReady(runId);
    const runContext = await this.loadRunContext(runId);

    const seenFingerprints = new Set<string>();
    for (const prior of await this.decisions.listByRunId(runId)) {
      for (const finding of prior.findings) {
        if (finding.blocking) {
          seenFingerprints.add(finding.semanticFingerprint);
        }
      }
    }

    const supersededPlanIds: string[] = [];
    let attempt = 0;
    let contextualAssessmentUsed = false;

    for (;;) {
      attempt += 1;
      const key: ValidationFenceKey = {
        runId,
        planId: record.planId,
        planVersion: record.planVersion,
        planHash: record.planHash,
      };

      const begin = await this.coordinator.begin(key, this.clock.nowIso());
      if (begin.outcome === "ALREADY_DECIDED") {
        const decided = begin.fence.validationDecisionId
          ? await this.decisions.getById(begin.fence.validationDecisionId)
          : null;
        if (!decided) {
          throw new ValidationError(
            "VALIDATION_RECONCILIATION_FAILED",
            "Validation fence is DECIDED but no decision record exists",
            { runId, fenceKey: validationFenceKey(key) },
          );
        }
        if (decided.decision !== "REVISE") {
          return this.toResult({
            decision: decided,
            record,
            reasonCodes: [],
            supersededPlanIds,
            revisionAttemptsUsed: record.planVersion - 1,
            contextualAssessmentUsed,
          });
        }
        const next = await this.plans.getVersion(runId, record.planVersion + 1);
        if (!next) {
          throw new ValidationError(
            "VALIDATION_RECONCILIATION_FAILED",
            "A revision was decided but the revised plan version is missing",
            { runId, planVersion: record.planVersion + 1 },
          );
        }
        record = next;
        continue;
      }

      try {
        record = await this.markUnderValidation(record);

        const deterministicResult = await this.deterministic.evaluate({
          runId,
          record,
          control: runContext.control,
          environment: runContext.environment,
          liveLock: runContext.liveLock,
          repositoryContext: runContext.repositoryContext,
        });
        const findings: ValidationFinding[] = [...deterministicResult.findings];

        let compiledContext: PlanningContext | null = null;
        const plan = deterministicResult.plan;
        if (deterministicResult.contextualEligible && plan) {
          compiledContext = await this.compileContext(runId, runContext);
          const assessment = await this.assessContextually({
            runId,
            record,
            plan,
            context: compiledContext,
            deterministicFindings: deterministicResult.findings,
            validationAttempt: attempt,
            budget: runContext.control.resourceBudget,
          });
          contextualAssessmentUsed = true;
          findings.push(...this.contextualFindings(assessment));
        }

        const blocking = findings.filter((finding) => finding.blocking);
        const repeatedFingerprints = this.fingerprints.repeated(
          seenFingerprints,
          blocking.map((finding) => finding.semanticFingerprint),
        );
        const revisionAttemptsUsed = record.planVersion - 1;
        const remainingRevisionAttempts = Math.max(
          0,
          Math.min(
            this.maxRevisionAttempts - revisionAttemptsUsed,
            MAX_REVISED_PLAN_VERSION - record.planVersion,
          ),
        );

        const outcome = this.decisionEngine.decide({
          findings,
          repeatedFingerprints,
          remainingRevisionAttempts,
        });

        if (outcome.decision === "REVISE" && plan && compiledContext) {
          let revised: StoredPlanRecord | null = null;
          let revisionFailure: ValidationError | null = null;
          try {
            revised = await this.revise({
              runId,
              record,
              plan,
              context: compiledContext,
              runContext,
              findings,
              priorSemanticFingerprints: [...seenFingerprints],
              validationAttempt: attempt,
            });
          } catch (error) {
            if (!isValidationError(error)) {
              throw error;
            }
            revisionFailure = error;
          }

          if (revised) {
            const decision = await this.persistDecision({
              runId,
              record,
              runContext,
              findings,
              decision: "REVISE",
              requiresHumanAction: false,
              validationAttempt: attempt,
            });
            await this.coordinator.markDecided(
              key,
              begin.ownerToken,
              this.clock.nowIso(),
              {
                validationDecisionId: decision.validationDecisionId,
                decision: "REVISE",
              },
            );
            for (const finding of blocking) {
              seenFingerprints.add(finding.semanticFingerprint);
            }
            supersededPlanIds.push(record.planId);
            await this.plans.markSuperseded(record.planId);
            record = revised;
            continue;
          }

          const failureFinding = this.findings.create({
            validatorType: "STATE",
            category: "revision",
            severity: "ERROR",
            ruleId:
              revisionFailure?.code === "REVISION_BUDGET_EXCEEDED"
                ? "REVISION_BUDGET_EXCEEDED"
                : "REVISION_FAILED",
            message:
              revisionFailure?.message ??
              "A permitted revision could not be produced",
            repairable: false,
            approvalEligible: true,
            blocking: true,
            subject: { code: revisionFailure?.code ?? "REVISION_FAILED" },
            metadata: {
              code: revisionFailure?.code ?? "REVISION_FAILED",
              details: revisionFailure?.details ?? {},
            },
          });
          findings.push(failureFinding);
          const budgetExhausted =
            revisionFailure?.code === "REVISION_BUDGET_EXCEEDED";
          return await this.finalize({
            key,
            ownerToken: begin.ownerToken,
            runId,
            record,
            runContext,
            findings,
            decision: "HUMAN_APPROVAL_REQUIRED",
            reasonCodes: ["REVISION_FAILED"],
            requiresHumanAction: true,
            validationAttempt: attempt,
            revisionAttemptsUsed,
            supersededPlanIds,
            contextualAssessmentUsed,
            exceptionType: budgetExhausted
              ? "REVISION_BUDGET_EXCEEDED"
              : "REVISION_FAILED",
          });
        }

        const exceptionType = this.exceptionTypeFor(
          outcome.decision,
          outcome.reasonCodes,
        );
        return await this.finalize({
          key,
          ownerToken: begin.ownerToken,
          runId,
          record,
          runContext,
          findings,
          decision:
            outcome.decision === "REVISE"
              ? "HUMAN_APPROVAL_REQUIRED"
              : outcome.decision,
          reasonCodes:
            outcome.decision === "REVISE"
              ? ["REVISION_FAILED"]
              : outcome.reasonCodes,
          requiresHumanAction:
            outcome.decision === "REVISE" ? true : outcome.requiresHumanAction,
          validationAttempt: attempt,
          revisionAttemptsUsed,
          supersededPlanIds,
          contextualAssessmentUsed,
          ...(exceptionType !== null ? { exceptionType } : {}),
        });
      } catch (error) {
        const failureCode = isValidationError(error)
          ? error.code
          : "INVALID_VALIDATION_STATE";
        await this.coordinator
          .markFailed(key, begin.ownerToken, {
            failureCode,
            failedAt: this.clock.nowIso(),
            retryable: true,
          })
          .catch(() => undefined);
        throw error;
      }
    }
  }

  async getLatestDecision(runId: string): Promise<ValidationDecision | null> {
    return this.decisions.getLatestByRunId(runId);
  }

  async listDecisions(
    runId: string,
  ): Promise<readonly ValidationDecision[]> {
    return this.decisions.listByRunId(runId);
  }

  async getPlan(runId: string): Promise<StoredPlanRecord | null> {
    return this.plans.getByRunId(runId);
  }

  async assess(runId: string): Promise<ValidationReadinessResult> {
    return this.readiness.assess(runId);
  }

  /**
   * A run whose latest plan already carries a terminal decision is not
   * re-adjudicated. The recorded decision is replayed so a repeated call is
   * idempotent and never produces a second, divergent verdict.
   */
  private async settledResult(runId: string): Promise<ValidationResult | null> {
    const record = await this.plans.getByRunId(runId);
    if (!record) {
      return null;
    }
    const fence = await this.coordinator.get({
      runId,
      planId: record.planId,
      planVersion: record.planVersion,
      planHash: record.planHash,
    });
    if (fence?.status !== "DECIDED" || !fence.validationDecisionId) {
      return null;
    }
    const decision = await this.decisions.getById(fence.validationDecisionId);
    if (!decision || decision.decision === "REVISE") {
      return null;
    }
    const superseded = (await this.plans.listByRunId(runId))
      .filter((entry) => entry.status === "SUPERSEDED")
      .map((entry) => entry.planId);
    return this.toResult({
      decision,
      record,
      reasonCodes: [],
      supersededPlanIds: superseded,
      revisionAttemptsUsed: record.planVersion - 1,
      contextualAssessmentUsed: false,
    });
  }

  private async loadRunContext(runId: string): Promise<ValidationRunContext> {
    const run = await this.runs.getById(runId);
    if (!run) {
      throw new ValidationError(
        "VALIDATION_NOT_READY",
        `Run not found: ${runId}`,
        { runId },
      );
    }
    const control = await this.controlPlane.resolve(
      run.projectId,
      run.requestedEnvironment,
    );
    return {
      projectId: run.projectId,
      environment: run.requestedEnvironment,
      control,
      repositoryContext: await this.contexts.getByRunId(runId),
      liveLock: await this.locks.getByRunId(runId),
    };
  }

  private async markUnderValidation(
    record: StoredPlanRecord,
  ): Promise<StoredPlanRecord> {
    if (record.status === "UNDER_VALIDATION") {
      return record;
    }
    return this.plans.save({ ...record, status: "UNDER_VALIDATION" });
  }

  private planStatusFor(decision: ValidationDecisionClass): StoredPlanStatus {
    switch (decision) {
      case "PASS":
        return "VALIDATED_PASS";
      case "BLOCK":
        return "VALIDATED_BLOCK";
      case "HUMAN_APPROVAL_REQUIRED":
        return "VALIDATED_APPROVAL_REQUIRED";
      case "REVISE":
        return "SUPERSEDED";
      default:
        return "UNDER_VALIDATION";
    }
  }

  private exceptionTypeFor(
    decision: ValidationDecisionClass,
    reasonCodes: readonly ValidationReasonCode[],
  ): PlanningExceptionType | null {
    if (decision === "BLOCK") {
      return "UNREPAIRABLE_VIOLATION";
    }
    if (reasonCodes.includes("REPEATED_SEMANTIC_VIOLATION")) {
      return "REPEATED_SEMANTIC_VIOLATION";
    }
    if (reasonCodes.includes("REVISION_ATTEMPTS_EXHAUSTED")) {
      return "REVISION_ATTEMPTS_EXHAUSTED";
    }
    return null;
  }

  private async finalize(input: {
    key: ValidationFenceKey;
    ownerToken: string;
    runId: string;
    record: StoredPlanRecord;
    runContext: ValidationRunContext;
    findings: readonly ValidationFinding[];
    decision: ValidationDecisionClass;
    reasonCodes: readonly ValidationReasonCode[];
    requiresHumanAction: boolean;
    validationAttempt: number;
    revisionAttemptsUsed: number;
    supersededPlanIds: readonly string[];
    contextualAssessmentUsed: boolean;
    exceptionType?: PlanningExceptionType;
  }): Promise<ValidationResult> {
    const decision = await this.persistDecision({
      runId: input.runId,
      record: input.record,
      runContext: input.runContext,
      findings: input.findings,
      decision: input.decision,
      requiresHumanAction: input.requiresHumanAction,
      validationAttempt: input.validationAttempt,
    });

    await this.coordinator.markDecided(
      input.key,
      input.ownerToken,
      this.clock.nowIso(),
      {
        validationDecisionId: decision.validationDecisionId,
        decision: input.decision,
      },
    );

    const planStatus = this.planStatusFor(input.decision);
    const record = await this.plans.save({
      ...input.record,
      status: planStatus,
    });

    await this.assertRunStaysValidating(input.runId);

    let exception: PlanningException | undefined;
    if (input.exceptionType) {
      exception = createPlanningException({
        exceptionId: this.identities.nextExceptionId(),
        runId: input.runId,
        planId: record.planId,
        planVersion: record.planVersion,
        planHash: record.planHash,
        exceptionType: input.exceptionType,
        decisionClass:
          input.decision === "BLOCK" ? "BLOCK" : "HUMAN_APPROVAL_REQUIRED",
        reasonCodes:
          input.reasonCodes.length > 0
            ? input.reasonCodes
            : [input.exceptionType],
        message: `Automated validation stopped: ${input.exceptionType}`,
        findings: input.findings,
        validationAttempt: input.validationAttempt,
        revisionAttemptsUsed: input.revisionAttemptsUsed,
        raisedAt: this.clock.nowIso(),
      });
    }

    return this.toResult({
      decision,
      record,
      reasonCodes: input.reasonCodes,
      supersededPlanIds: input.supersededPlanIds,
      revisionAttemptsUsed: input.revisionAttemptsUsed,
      contextualAssessmentUsed: input.contextualAssessmentUsed,
      ...(exception !== undefined ? { exception } : {}),
    });
  }

  private toResult(input: {
    decision: ValidationDecision;
    record: StoredPlanRecord;
    reasonCodes: readonly ValidationReasonCode[];
    supersededPlanIds: readonly string[];
    revisionAttemptsUsed: number;
    contextualAssessmentUsed: boolean;
    exception?: PlanningException;
  }): ValidationResult {
    const result: ValidationResult = {
      outcome: "VALIDATED",
      runId: input.decision.runId,
      planId: input.decision.planId,
      planVersion: input.decision.planVersion,
      planHash: input.decision.planHash,
      decision: input.decision.decision,
      validationDecisionId: input.decision.validationDecisionId,
      validationAttempt: input.decision.validationAttempt,
      reasonCodes: input.reasonCodes,
      requiresHumanAction: input.decision.requiresHumanAction,
      findings: input.decision.findings,
      planStatus: input.record.status,
      runState: "VALIDATING",
      revisionAttemptsUsed: input.revisionAttemptsUsed,
      supersededPlanIds: input.supersededPlanIds,
      contextualAssessmentUsed: input.contextualAssessmentUsed,
    };
    if (input.exception !== undefined) {
      result.exception = input.exception;
    }
    return result;
  }

  private async persistDecision(input: {
    runId: string;
    record: StoredPlanRecord;
    runContext: ValidationRunContext;
    findings: readonly ValidationFinding[];
    decision: ValidationDecisionClass;
    requiresHumanAction: boolean;
    validationAttempt: number;
  }): Promise<ValidationDecision> {
    const decision = parseValidationDecision({
      validationDecisionId: this.identities.nextValidationDecisionId(),
      decision: input.decision,
      findings: [...input.findings],
      decidedAt: this.clock.nowIso(),
      validatorId: VALIDATOR_ID,
      runId: input.runId,
      planId: input.record.planId,
      planVersion: input.record.planVersion,
      planHash: input.record.planHash,
      policyBundleHash: input.runContext.control.activePolicyBundle.policyHash,
      repositoryFingerprint:
        input.runContext.repositoryContext?.repositoryFingerprint ??
        input.record.plan.repositoryFingerprint,
      validationAttempt: input.validationAttempt,
      requiresHumanAction: input.requiresHumanAction,
    });
    try {
      return await this.decisions.save(decision);
    } catch (error) {
      throw new ValidationError(
        "VALIDATION_DECISION_PERSISTENCE_FAILED",
        "Failed to persist the validation decision",
        { cause: String(error) },
      );
    }
  }

  private async assertRunStaysValidating(runId: string): Promise<void> {
    const run = await this.runs.getById(runId);
    if (!run) {
      throw new ValidationError(
        "INVALID_VALIDATION_STATE",
        "Run disappeared during validation",
        { runId },
      );
    }
    if (run.state !== "VALIDATING") {
      throw new ValidationError(
        "INVALID_VALIDATION_STATE",
        `Run left VALIDATING during validation (now ${run.state})`,
        { runId, state: run.state },
      );
    }
  }

  /**
   * Contextual observations are advisory recommendations translated into
   * structured findings. The model never sets ValidationDecision directly.
   *
   * A bare recommendation (e.g. model says BLOCK with no observations) becomes
   * a non-blocking CONTEXTUAL_RECOMMENDATION finding only.
   *
   * Structured observations are classified deterministically:
   * ERROR/CRITICAL → blocking; repairable flag from the observation.
   * Unrepairable blocking contextual findings are NOT approval-eligible, so
   * ValidationDecisionEngine may produce authoritative BLOCK under its
   * precedence rules. That BLOCK comes from the engine, not from the model's
   * recommendation field.
   */
  private contextualFindings(
    assessment: ContextualValidationAssessment,
  ): ValidationFinding[] {
    const results: ValidationFinding[] = [];

    for (const observation of assessment.observations) {
      const blocking =
        observation.severity === "ERROR" || observation.severity === "CRITICAL";
      results.push(
        this.findings.create({
          validatorType: "CONTEXTUAL",
          category: observation.category,
          severity: observation.severity,
          ruleId: observation.ruleId,
          message: observation.message,
          evidenceRefs: observation.evidenceRefs,
          affectedStepIds: observation.affectedStepIds,
          repairable: observation.repairable,
          // Unrepairable blocking contextual findings may become authoritative
          // BLOCK via DecisionEngine. Recommendation alone never does.
          approvalEligible: false,
          blocking,
          subject: {
            ruleId: observation.ruleId,
            stepIds: [...observation.affectedStepIds],
          },
          metadata: {
            advisorySource: true,
            rationale: observation.rationale,
            modelRecommendation: assessment.recommendation,
            confidence: assessment.confidence,
          },
        }),
      );
    }

    if (assessment.unsupportedClaims.length > 0) {
      results.push(
        this.findings.create({
          validatorType: "CONTEXTUAL",
          category: "evidence-grounding",
          severity: "INFO",
          ruleId: "CONTEXTUAL_UNSUPPORTED_CLAIMS",
          message: "Contextual validator reported unsupported plan claims",
          repairable: true,
          approvalEligible: false,
          blocking: false,
          subject: { count: assessment.unsupportedClaims.length },
          metadata: {
            advisorySource: true,
            unsupportedClaims: [...assessment.unsupportedClaims],
          },
        }),
      );
    }

    if (assessment.recommendation !== "PASS") {
      results.push(
        this.findings.create({
          validatorType: "CONTEXTUAL",
          category: "advisory-recommendation",
          severity: "INFO",
          ruleId: "CONTEXTUAL_RECOMMENDATION",
          message: `Contextual validator recommended ${assessment.recommendation} (advisory only; not authoritative)`,
          repairable: false,
          approvalEligible: false,
          blocking: false,
          subject: { recommendation: assessment.recommendation },
          metadata: {
            advisorySource: true,
            recommendation: assessment.recommendation,
            confidence: assessment.confidence,
            summary: assessment.summary,
            coverageGaps: [...assessment.coverageGaps],
          },
        }),
      );
    }

    return results;
  }

  private async assessContextually(input: {
    runId: string;
    record: StoredPlanRecord;
    plan: ExecutionPlan;
    context: PlanningContext;
    deterministicFindings: readonly ValidationFinding[];
    validationAttempt: number;
    budget: ResourceBudgetProfile;
  }): Promise<ContextualValidationAssessment> {
    const assembled: AssembledValidationPrompt = this.prompts.assemble({
      plan: input.plan,
      context: input.context,
      deterministicFindings: input.deterministicFindings,
    });
    return this.invokeModel({
      runId: input.runId,
      record: input.record,
      validationAttempt: input.validationAttempt,
      operation: "CONTEXTUAL_ASSESSMENT",
      budget: input.budget,
      assembled,
      provider: this.model.provider,
      modelId: this.model.modelId,
      invoke: async () =>
        this.model.validatePlan({
          plan: input.plan,
          deterministicFindings: input.deterministicFindings,
          context: input.context,
          promptVersion: this.prompts.promptVersion,
        }),
    });
  }

  private async revise(input: {
    runId: string;
    record: StoredPlanRecord;
    plan: ExecutionPlan;
    context: PlanningContext;
    runContext: ValidationRunContext;
    findings: readonly ValidationFinding[];
    priorSemanticFingerprints: readonly string[];
    validationAttempt: number;
  }): Promise<StoredPlanRecord> {
    const targetPlanVersion = input.record.planVersion + 1;
    if (targetPlanVersion > MAX_REVISED_PLAN_VERSION) {
      throw new ValidationError(
        "REVISION_LIMIT_EXCEEDED",
        `Automated revision may not produce plan version ${targetPlanVersion}`,
        { runId: input.runId, targetPlanVersion },
      );
    }

    const envelope = this.envelopes.build({
      envelopeId: this.identities.nextRevisionEnvelopeId(),
      runId: input.runId,
      plan: input.plan,
      targetPlanVersion,
      revisionAttempt: input.record.planVersion,
      control: input.runContext.control,
      environment: input.runContext.environment,
      findings: input.findings,
      priorSemanticFingerprints: input.priorSemanticFingerprints,
      createdAt: this.clock.nowIso(),
    });

    const assembled = this.revisionPrompts.assemble({
      envelope,
      plan: input.plan,
      context: input.context,
    });

    const proposal = await this.invokeModel({
      runId: input.runId,
      record: input.record,
      validationAttempt: input.validationAttempt,
      operation: "PLAN_REVISION",
      budget: input.runContext.control.resourceBudget,
      assembled,
      provider: this.revisionModel.provider,
      modelId: this.revisionModel.modelId,
      sourcePlanVersion: input.record.planVersion,
      targetPlanVersion,
      revisionAttempt: input.record.planVersion,
      invoke: async () =>
        this.revisionModel.revisePlan({
          envelope,
          plan: input.plan,
          context: input.context,
          promptVersion: this.revisionPrompts.promptVersion,
        }),
    });

    let revisedPlan: ExecutionPlan;
    try {
      const evidenceList = await this.evidence.listByRunId(input.runId);
      const evidenceById = new Map(
        evidenceList.map((evidenceRecord) => [
          evidenceRecord.evidenceId,
          evidenceRecord,
        ]),
      );
      this.evidenceRefs.validate({
        evidenceRefs: [
          ...proposal.steps.flatMap((step) => step.evidenceRefs),
          ...proposal.gapAnalysis.evidenceRefs,
        ],
        evidenceById,
        runId: input.runId,
        projectId: input.runContext.projectId,
        lockedCommitSha: input.plan.repositoryCommitSha,
      });
      await this.capabilityRefs.validate({
        actionTypes: proposal.steps.map((step) => step.actionType),
        environment: input.runContext.environment,
      });
      const graph = this.dependencies.validate(proposal.steps);
      const resources = this.resources.analyze(
        proposal,
        input.runContext.control.resourceBudget,
      );
      this.quality.score(proposal, input.context);
      revisedPlan = this.compiler.compile({
        proposal,
        context: input.context,
        graph,
        resources,
        planVersion: targetPlanVersion,
      });
    } catch (error) {
      throw new ValidationError(
        "REVISION_COMPILATION_FAILED",
        isPlanningError(error)
          ? `Revised plan failed ${error.code}: ${error.message}`
          : "Revised plan could not be compiled",
        {
          runId: input.runId,
          targetPlanVersion,
          ...(isPlanningError(error) ? { planningCode: error.code } : {}),
        },
      );
    }

    try {
      return await this.plans.save({
        planId: revisedPlan.planId,
        runId: input.runId,
        planVersion: targetPlanVersion,
        status: "READY_FOR_VALIDATION",
        plan: revisedPlan,
        planHash: revisedPlan.planHash,
        planningContextFingerprint:
          input.context.contextMetadata.planningContextFingerprint,
        planningPromptVersion: PLANNING_PROMPT_VERSION,
        modelProvider: this.revisionModel.provider,
        modelId: this.revisionModel.modelId,
        createdAt: this.clock.nowIso(),
        supersedesPlanId: input.record.planId,
        lineageRootPlanId: input.record.lineageRootPlanId ?? input.record.planId,
      });
    } catch (error) {
      throw new ValidationError(
        "REVISION_PERSISTENCE_FAILED",
        "Failed to persist the revised plan",
        { cause: String(error) },
      );
    }
  }

  private async invokeModel<T>(input: {
    runId: string;
    record: StoredPlanRecord;
    validationAttempt: number;
    operation: ValidationModelOperation;
    budget: ResourceBudgetProfile;
    assembled: AssembledValidationPromptLike;
    provider: string;
    modelId: string;
    sourcePlanVersion?: number;
    targetPlanVersion?: number;
    revisionAttempt?: number;
    invoke: () => Promise<{ value: T; usage?: ValidationModelTokenUsage }>;
  }): Promise<T> {
    const maxOutputTokens = this.maxOutputTokensByOperation[input.operation];
    const inputTokenEstimate = this.tokenEstimator.estimateInputTokens(
      input.assembled,
    );
    const { reservedTokens } = await this.inferenceBudget.assertCanReserve({
      runId: input.runId,
      budget: input.budget,
      inputTokenEstimate,
      maxOutputTokens,
      operation: input.operation,
    });

    const callId = randomUUID();
    await this.usage.reserve({
      callId,
      runId: input.runId,
      planId: input.record.planId,
      planVersion: input.record.planVersion,
      validationAttempt: input.validationAttempt,
      operation: input.operation,
      provider: input.provider,
      model: input.modelId,
      reservedTokens,
      startedAt: this.clock.nowIso(),
      maximumLlmCalls: input.budget.maximumLlmCalls,
      maximumTotalTokens: input.budget.maximumTotalTokens,
      budgetProfileId: input.budget.budgetProfileId,
      ...(input.sourcePlanVersion !== undefined
        ? { sourcePlanVersion: input.sourcePlanVersion }
        : {}),
      ...(input.targetPlanVersion !== undefined
        ? { targetPlanVersion: input.targetPlanVersion }
        : {}),
      ...(input.revisionAttempt !== undefined
        ? { revisionAttempt: input.revisionAttempt }
        : {}),
    });

    try {
      const result = await input.invoke();
      await this.settle(callId, "SUCCESS", reservedTokens, result.usage, input);
      return result.value;
    } catch (error) {
      if (
        isValidationError(error) &&
        error.code === "VALIDATION_MODEL_BUDGET_INVARIANT_VIOLATION"
      ) {
        throw error;
      }
      if (isValidationPreDispatchError(error)) {
        await this.usage.settle(callId, {
          outcome: "RELEASED",
          completedAt: this.clock.nowIso(),
          charging: "NONE",
          reason: "PRE_DISPATCH_FAILURE",
        });
        throw this.mapModelError(error);
      }
      await this.settle(
        callId,
        this.usageStatus(error),
        reservedTokens,
        extractProviderUsage(error),
        input,
      );
      throw this.mapModelError(error);
    }
  }

  /**
   * Releases the reservation and charges actual usage when the provider
   * reported it. Usage above the reservation is recorded accurately and marks
   * the run's inference budget invariant violated, blocking further calls.
   */
  private async settle(
    callId: string,
    outcome: "SUCCESS" | "FAILED" | "TIMEOUT" | "REFUSED",
    reservedTokens: number,
    usage: ValidationModelTokenUsage | undefined,
    context: { operation: ValidationModelOperation; runId: string },
  ): Promise<void> {
    const actualTotal = resolveValidationChargedTokenTotal(usage);
    if (actualTotal === undefined) {
      await this.usage.settle(callId, {
        outcome,
        completedAt: this.clock.nowIso(),
        charging: "RESERVATION",
      });
      return;
    }

    const overrun = actualTotal > reservedTokens;
    const update: {
      outcome: "SUCCESS" | "FAILED" | "TIMEOUT" | "REFUSED";
      completedAt: string;
      charging: "ACTUAL";
      totalUsage: number;
      inputUsage?: number;
      outputUsage?: number;
      markInvariantViolation?: boolean;
    } = {
      outcome,
      completedAt: this.clock.nowIso(),
      charging: "ACTUAL",
      totalUsage: actualTotal,
    };
    if (usage?.inputTokens !== undefined) {
      update.inputUsage = usage.inputTokens;
    }
    if (usage?.outputTokens !== undefined) {
      update.outputUsage = usage.outputTokens;
    }
    if (overrun) {
      update.markInvariantViolation = true;
    }
    await this.usage.settle(callId, update);
    if (overrun) {
      throw new ValidationError(
        "VALIDATION_MODEL_BUDGET_INVARIANT_VIOLATION",
        "Provider reported token usage exceeding the pre-call reservation",
        {
          reservedTokens,
          actualTotal,
          operation: context.operation,
          runId: context.runId,
        },
      );
    }
  }

  private mapModelError(error: unknown): ValidationError {
    if (isValidationError(error)) {
      return error;
    }
    return new ValidationError(
      "VALIDATION_MODEL_INVALID_OUTPUT",
      error instanceof Error ? error.message : "Validation model failed",
    );
  }

  private usageStatus(error: unknown): "FAILED" | "TIMEOUT" | "REFUSED" {
    if (isValidationError(error)) {
      if (error.code === "VALIDATION_MODEL_TIMEOUT") {
        return "TIMEOUT";
      }
      if (error.code === "VALIDATION_MODEL_REFUSED") {
        return "REFUSED";
      }
    }
    return "FAILED";
  }

  /** Recompiles the bounded planning context for contextual review/revision. */
  private async compileContext(
    runId: string,
    runContext: ValidationRunContext,
  ): Promise<PlanningContext> {
    const run = await this.runs.getById(runId);
    const objective = await this.objectives.getByRunBinding(runId);
    if (!run) {
      throw new ValidationError(
        "VALIDATION_NOT_READY",
        `Run not found: ${runId}`,
      );
    }
    if (!objective) {
      throw new ValidationError(
        "OBJECTIVE_NOT_FOUND",
        `No objective bound to run ${runId}`,
      );
    }
    if (!runContext.repositoryContext || !runContext.liveLock) {
      throw new ValidationError(
        "VALIDATION_NOT_READY",
        "Verified repository context/lock missing",
        { runId },
      );
    }

    const evidenceList = await this.evidence.listByRunId(runId);
    const remoteUrl = `https://github.com/${runContext.liveLock.repositoryIdentity.owner}/${runContext.liveLock.repositoryIdentity.repository}`;
    const contentByEvidenceId = await this.loadEvidenceContent(
      runId,
      runContext.liveLock.commitSha,
      remoteUrl,
      evidenceList,
    );

    try {
      return this.contextCompiler.compile({
        run,
        objective,
        control: runContext.control,
        repositoryContext: runContext.repositoryContext,
        liveLock: runContext.liveLock,
        evidence: evidenceList,
        contentByEvidenceId,
      });
    } catch (error) {
      throw new ValidationError(
        "VALIDATION_NOT_READY",
        isPlanningError(error)
          ? `Context compilation failed: ${error.message}`
          : "Context compilation failed",
        { runId },
      );
    }
  }

  private async loadEvidenceContent(
    runId: string,
    lockedCommitSha: string,
    remoteUrl: string,
    evidenceList: Awaited<ReturnType<EvidenceRegistry["listByRunId"]>>,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const prepared = await this.workspace.prepareWorkspace(runId, remoteUrl);
      await this.workspace.fetchRemote(prepared);
      await this.workspace.checkoutDetachedCommit(
        prepared,
        lockedCommitSha as CommitSha,
      );
      for (const record of evidenceList) {
        if (record.sourcePath) {
          try {
            const buffer = await this.workspace.readFile(
              prepared,
              record.sourcePath,
            );
            map.set(
              record.evidenceId,
              buffer.includes(0)
                ? `[binary omitted] size=${buffer.byteLength} hash=${record.contentHash}`
                : buffer.toString("utf8"),
            );
          } catch {
            map.set(record.evidenceId, record.summary);
          }
        } else {
          map.set(record.evidenceId, record.summary);
        }
      }
    } catch {
      for (const record of evidenceList) {
        map.set(record.evidenceId, record.summary);
      }
    }
    return map;
  }
}

function extractProviderUsage(
  error: unknown,
): ValidationModelTokenUsage | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "providerUsage" in error &&
    typeof (error as { providerUsage: unknown }).providerUsage === "object" &&
    (error as { providerUsage: unknown }).providerUsage !== null
  ) {
    return (error as { providerUsage: ValidationModelTokenUsage }).providerUsage;
  }
  return undefined;
}
