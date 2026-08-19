import type { ClockPort } from "../infrastructure/clock.js";
import { assertNotInTransaction } from "../durability/transaction.js";
import { commitRunTransition } from "../admission/run-transition.js";
import type { RunRepository } from "../admission/run-repository.js";
import type { ObjectiveRepository } from "../admission/objective-repository.js";
import type { PlanRepository } from "../planning/plan-repository.js";
import type { AuthorizationRecordRepository } from "../authorization/authorization-record-repository.js";
import type { EventStore } from "../admission/event-store.js";
import type { ControlPlaneService } from "../control-plane/service.js";
import type { ExecutionService } from "../execution/service.js";
import type { ExecutionCoordinator } from "../execution/coordinator.js";
import type { StepExecutionRepository } from "../execution/step-repository.js";
import type { ExecutionArtifactRepository } from "../execution/artifact-repository.js";
import type { ExecutionAttemptRepository } from "../execution/attempt-repository.js";
import { assertTransition } from "../domain/run/run-state.js";
import {
  parseCompletionRecord,
  parseOutcomeVerificationRecord,
  parseVerificationAttempt,
  parseVerificationResult,
  type VerificationResult,
} from "../domain/verification/index.js";
import { workspaceRootFor } from "../ingestion/workspace-paths.js";
import {
  VerificationError,
  isVerificationError,
  isVerificationPreDispatchError,
} from "./errors.js";
import {
  SequenceVerificationIdentityGenerator,
  type VerificationIdentityGenerator,
} from "./identity.js";
import {
  InMemoryVerificationCoordinator,
  type VerificationCoordinator,
  type VerificationFenceKey,
} from "./coordinator.js";
import { VerificationReadinessService } from "./readiness.js";
import {
  PostExecutionSnapshotHasher,
  PostExecutionTruthService,
} from "./snapshot.js";
import { VerificationSpecificationCompiler } from "./specification.js";
import { DeterministicOutcomeVerificationService } from "./deterministic.js";
import { OutcomeDecisionEngine } from "./decision-engine.js";
import type { VerificationModel } from "./model.js";
import { FakeVerificationModel } from "./fake-model.js";
import {
  InMemoryVerificationInferenceLedger,
  VerificationInferenceBudget,
  type VerificationInferenceLedger,
} from "./inference-ledger.js";
import type { VerificationEvidenceRepository } from "./evidence-repository.js";
import { InMemoryVerificationEvidenceRepository } from "./evidence-repository.js";
import type { OutcomeVerificationRepository } from "./outcome-repository.js";
import { InMemoryOutcomeVerificationRepository } from "./outcome-repository.js";
import type { CompletionRecordRepository } from "./completion-repository.js";
import { InMemoryCompletionRecordRepository } from "./completion-repository.js";
import { parseContextualOutcomeInput } from "./model.js";
import {
  withOptionalTransaction,
  type TransactionManager,
} from "../durability/transaction.js";

export type VerificationCompletionStage =
  | "AFTER_OUTCOME_RECORD"
  | "AFTER_COMPLETION_RECORD"
  | "AFTER_RUN_TRANSITION"
  | "AFTER_EVENT_APPEND";

export interface VerificationCompletionFailpoint {
  hit(stage: VerificationCompletionStage): Promise<void>;
}

export interface OutcomeVerificationServiceDeps {
  runs: RunRepository;
  plans: PlanRepository;
  objectives: ObjectiveRepository;
  authorizationRecords: AuthorizationRecordRepository;
  execution: ExecutionService;
  executionCoordinator: ExecutionCoordinator;
  steps: StepExecutionRepository;
  attempts: ExecutionAttemptRepository;
  artifacts: ExecutionArtifactRepository;
  readiness: VerificationReadinessService;
  coordinator?: VerificationCoordinator;
  evidence?: VerificationEvidenceRepository;
  outcomes?: OutcomeVerificationRepository;
  completions?: CompletionRecordRepository;
  model?: VerificationModel;
  inferenceLedger?: VerificationInferenceLedger;
  clock: ClockPort;
  dataRoot: string;
  controlPlane?: ControlPlaneService;
  events?: EventStore;
  identities?: VerificationIdentityGenerator;
  /** When false, skip contextual model even if configured. Default true. */
  enableContextualModel?: boolean;
  blobStore?: import("../durability/artifacts.js").ArtifactBlobStore;
  transactions?: TransactionManager;
  completionFailpoint?: VerificationCompletionFailpoint;
}

/**
 * Phase 8 independent outcome verification.
 *
 * EXECUTION_SUCCEEDED ≠ VERIFIED_SUCCESS.
 * Model may downgrade only; never creates VERIFIED_SUCCESS authority.
 * CompletionRecord only for VERIFIED_SUCCESS.
 * No remediation (no re-execute, replan, approve, actuate).
 */
export class OutcomeVerificationService {
  private readonly identities: VerificationIdentityGenerator;
  private readonly coordinator: VerificationCoordinator;
  private readonly evidence: VerificationEvidenceRepository;
  private readonly outcomes: OutcomeVerificationRepository;
  private readonly completions: CompletionRecordRepository;
  private readonly model: VerificationModel;
  private readonly inferenceLedger: VerificationInferenceLedger;
  private readonly inferenceBudget: VerificationInferenceBudget;
  private readonly truth: PostExecutionTruthService;
  private readonly snapshotHasher = new PostExecutionSnapshotHasher();
  private readonly specCompiler: VerificationSpecificationCompiler;
  private readonly deterministic: DeterministicOutcomeVerificationService;
  private readonly decisionEngine = new OutcomeDecisionEngine();
  private readonly enableContextualModel: boolean;
  private readonly transactions: TransactionManager | undefined;
  private readonly resultsByRun = new Map<string, VerificationResult>();

  constructor(private readonly deps: OutcomeVerificationServiceDeps) {
    this.identities =
      deps.identities ?? new SequenceVerificationIdentityGenerator();
    this.coordinator =
      deps.coordinator ?? new InMemoryVerificationCoordinator();
    this.evidence =
      deps.evidence ?? new InMemoryVerificationEvidenceRepository();
    this.outcomes =
      deps.outcomes ?? new InMemoryOutcomeVerificationRepository();
    this.completions =
      deps.completions ?? new InMemoryCompletionRecordRepository();
    this.model = deps.model ?? new FakeVerificationModel();
    this.inferenceLedger =
      deps.inferenceLedger ?? new InMemoryVerificationInferenceLedger();
    this.inferenceBudget = new VerificationInferenceBudget(this.inferenceLedger);
    this.truth = new PostExecutionTruthService({
      execution: deps.execution,
      steps: deps.steps,
      artifacts: deps.artifacts,
      ...(deps.events !== undefined ? { events: deps.events } : {}),
    });
    this.specCompiler = new VerificationSpecificationCompiler(this.identities);
    this.deterministic = new DeterministicOutcomeVerificationService(
      this.identities,
    );
    this.enableContextualModel = deps.enableContextualModel !== false;
    this.transactions = deps.transactions;
  }

  async verify(runId: string): Promise<VerificationResult> {
    const run = await this.deps.runs.getById(runId);
    if (!run) {
      throw new VerificationError(
        "VERIFICATION_NOT_READY",
        `Run not found: ${runId}`,
      );
    }

    // Idempotent replay when already decided (COMPLETED / ESCALATED / prior DECIDED).
    const prior = this.resultsByRun.get(runId);
    if (prior) {
      return prior;
    }
    if (
      run.state === "COMPLETED" ||
      run.state === "ESCALATED" ||
      run.state === "CONTAINED"
    ) {
      const stored = await this.getLatestResult(runId);
      if (stored) {
        this.resultsByRun.set(runId, stored);
        return stored;
      }
    }

    const readiness = await this.deps.readiness.assess(runId);
    if (!readiness.ready) {
      throw new VerificationError(
        "VERIFICATION_NOT_READY",
        readiness.message,
        { code: readiness.code, ...(readiness.details ?? {}) },
      );
    }

    const result = await this.deps.execution.getLatestResult(runId);
    if (!result) {
      throw new VerificationError(
        "VERIFICATION_EXECUTION_RESULT_MISSING",
        "ExecutionResult missing after readiness",
      );
    }

    const planRecord = await this.deps.plans.getByRunId(runId);
    if (!planRecord) {
      throw new VerificationError(
        "VERIFICATION_NOT_READY",
        "Plan missing",
      );
    }
    const plan = planRecord.plan;
    const auth = await this.deps.authorizationRecords.getLatestByRun(runId);
    if (!auth) {
      throw new VerificationError(
        "VERIFICATION_NOT_READY",
        "AuthorizationRecord missing",
      );
    }

    const fenceKey: VerificationFenceKey = {
      runId,
      executionAttemptId: result.executionAttemptId,
      planId: plan.planId,
      planVersion: plan.planVersion,
      planHash: plan.planHash,
    };

    const begin = await this.coordinator.begin(
      fenceKey,
      this.deps.clock.nowIso(),
    );
    if (begin.outcome === "IN_PROGRESS") {
      throw new VerificationError(
        "VERIFICATION_IN_PROGRESS",
        "Verification already in progress for this execution attempt",
      );
    }
    if (begin.outcome === "ALREADY_DECIDED") {
      if (begin.result) {
        return begin.result;
      }
      const cached = this.resultsByRun.get(runId);
      if (cached) return cached;
      const stored = await this.outcomes.getByExecutionAttempt(
        result.executionAttemptId,
      );
      if (stored) {
        return parseVerificationResult({
          runId: stored.runId,
          executionAttemptId: stored.executionAttemptId,
          verificationAttemptId: stored.verificationAttemptId,
          outcomeVerificationId: stored.outcomeVerificationId,
          outcome: stored.outcome,
          criterionResults: stored.criterionResults,
          postconditionResults: stored.postconditionResults,
          evidenceRefs: stored.evidenceRefs,
          findings: stored.findings,
          postExecutionSnapshotHash: stored.postExecutionSnapshotHash,
          verificationSpecificationHash: stored.verificationSpecificationHash,
          requiresHumanReview: stored.outcome !== "VERIFIED_SUCCESS",
        });
      }
      throw new VerificationError(
        "VERIFICATION_ALREADY_DECIDED",
        "Verification already decided but result unavailable",
      );
    }

    const ownerToken = begin.ownerToken;
    const attemptNumber = begin.fence.attempt;
    const verificationAttemptId = this.identities.nextVerificationAttemptId();
    const nowIso = this.deps.clock.nowIso();

    const attempt = parseVerificationAttempt({
      verificationAttemptId,
      runId,
      executionAttemptId: result.executionAttemptId,
      planId: plan.planId,
      planVersion: plan.planVersion,
      planHash: plan.planHash,
      attemptNumber,
      startedAt: nowIso,
      status: "IN_PROGRESS",
    });
    void attempt;

    try {
      await this.appendEvent(runId, "VERIFICATION_STARTED", {
        verificationAttemptId,
        executionAttemptId: result.executionAttemptId,
      });

      const contained = readiness.contained || run.state === "CONTAINED";

      // Transition EXECUTING → VERIFYING (skip for already CONTAINED)
      if (!contained && run.state === "EXECUTING") {
        await commitRunTransition(
          this.deps.runs,
          run,
          "VERIFYING",
          this.deps.clock.nowIso(),
        );
      }

      const snapshot = await this.truth.capture({
        runId,
        result,
        nowIso: this.deps.clock.nowIso(),
      });
      const postExecutionSnapshotHash = this.snapshotHasher.hash(snapshot);
      await this.appendEvent(runId, "POST_EXECUTION_SNAPSHOT_CAPTURED", {
        postExecutionSnapshotHash,
      });

      const objective = await this.deps.objectives.getById(
        run.objectiveId,
        run.objectiveVersion,
      );
      if (!objective) {
        throw new VerificationError(
          "VERIFICATION_NOT_READY",
          "Objective missing",
        );
      }

      const specification = this.specCompiler.compile({
        runId,
        objective,
        plan,
      });

      const authoritySnapshot = await this.deps.execution.getAuthoritySnapshot(
        result.executionAttemptId,
      );
      if (!authoritySnapshot) {
        throw new VerificationError(
          "VERIFICATION_AUTHORITY_MISMATCH",
          "Authority snapshot missing during verification",
        );
      }

      const steps = await this.deps.steps.listByExecutionAttempt(
        result.executionAttemptId,
      );
      const compensatingIds = new Set(
        plan.steps.flatMap((p) => p.rollback.compensatingStepIds ?? []),
      );
      const rollbackCount = steps.filter(
        (s) =>
          compensatingIds.has(s.stepId) &&
          (s.status === "SUCCEEDED" || s.status === "COMPENSATED"),
      ).length;

      let liveCapabilities;
      if (this.deps.controlPlane) {
        try {
          const ctx = await this.deps.controlPlane.resolve(
            run.projectId,
            run.requestedEnvironment,
          );
          liveCapabilities = ctx.availableCapabilities;
        } catch {
          liveCapabilities = undefined;
        }
      }

      const deterministic = await this.deterministic.verify({
        runId,
        result,
        plan,
        authorization: auth,
        snapshot: authoritySnapshot,
        steps,
        specification,
        dataRoot: this.deps.dataRoot,
        workspaceRoot: workspaceRootFor(this.deps.dataRoot, runId),
        artifacts: this.deps.artifacts,
        rollbackCount,
        contained,
        ...(liveCapabilities !== undefined
          ? { liveCapabilities }
          : {}),
        ...(this.deps.blobStore !== undefined
          ? { blobStore: this.deps.blobStore }
          : {}),
      });

      for (const ev of deterministic.evidence) {
        await this.evidence.save(ev);
        await this.appendEvent(runId, "VERIFICATION_EVIDENCE_RECORDED", {
          evidenceId: ev.evidenceId,
        });
      }

      for (const cr of deterministic.criterionResults) {
        await this.appendEvent(runId, "ACCEPTANCE_CRITERION_EVALUATED", {
          criterionId: cr.criterionId,
          verdict: cr.verdict,
        });
      }
      for (const pc of deterministic.postconditionResults) {
        await this.appendEvent(runId, "POSTCONDITION_EVALUATED", {
          postconditionId: pc.postconditionId,
          verdict: pc.verdict,
        });
      }

      // Contextual model: only when useful and not already hard-failed
      let contextual = undefined;
      const hardBlocked =
        !deterministic.artifactIntegrityOk ||
        !deterministic.historicalAuthorityOk ||
        !deterministic.boundaryOk ||
        deterministic.findings.some(
          (f) =>
            f.blocksVerifiedSuccess &&
            (f.category === "BINDING" ||
              f.category === "ARTIFACT_INTEGRITY" ||
              f.category === "BOUNDARY" ||
              f.category === "AUTHORITY"),
        );

      if (
        this.enableContextualModel &&
        !hardBlocked &&
        !contained &&
        !deterministic.unresolvedSideEffectUncertainty
      ) {
        contextual = await this.runContextualModel({
          runId,
          verificationAttemptId,
          objective,
          plan,
          snapshot,
          deterministic,
        });
      }

      const approvedBindings =
        plan.acceptanceCriterionVerificationBindings ?? [];
      const allCriteriaHaveApprovedBindings =
        approvedBindings.length === objective.acceptanceCriteria.length &&
        deterministic.criterionResults.every((c) =>
          approvedBindings.some((b) => b.criterionId === c.criterionId),
        );
      const allBindingsFulfilled = deterministic.criterionResults.every(
        (c) =>
          c.verdict === "SATISFIED" &&
          c.evidenceRefs.length > 0 &&
          !c.verificationMethod.startsWith("KEYWORD_") &&
          c.verificationMethod !== "UNBOUND" &&
          c.verificationMethod !== "UNMAPPED",
      );

      const decision = this.decisionEngine.decide({
        contained,
        unresolvedSideEffectUncertainty:
          deterministic.unresolvedSideEffectUncertainty,
        criterionResults: deterministic.criterionResults,
        postconditionResults: deterministic.postconditionResults,
        findings: [
          ...deterministic.findings,
          ...(contextual?.findings ?? []),
        ],
        coverageComplete: deterministic.coverageComplete,
        artifactIntegrityOk: deterministic.artifactIntegrityOk,
        historicalAuthorityOk: deterministic.historicalAuthorityOk,
        boundaryOk: deterministic.boundaryOk,
        governanceOk: deterministic.governanceOk,
        allCriteriaHaveApprovedBindings,
        allBindingsFulfilled,
        contextual,
      });

      // Contained path: force CONTAINED outcome
      const outcome = contained ? "CONTAINED" : decision.outcome;

      const outcomeVerificationId =
        this.identities.nextOutcomeVerificationId();
      const allFindings = [
        ...deterministic.findings,
        ...(contextual?.findings ?? []),
      ];
      const evidenceRefs = deterministic.evidence.map((e) => e.evidenceId);

      const record = parseOutcomeVerificationRecord({
        outcomeVerificationId,
        verificationAttemptId,
        runId,
        executionAttemptId: result.executionAttemptId,
        planId: plan.planId,
        planVersion: plan.planVersion,
        planHash: plan.planHash,
        authorizationRecordId: auth.authorizationRecordId,
        postExecutionSnapshotHash,
        verificationSpecificationHash:
          specification.verificationSpecificationHash,
        outcome,
        criterionResults: deterministic.criterionResults,
        postconditionResults: deterministic.postconditionResults,
        findings: allFindings,
        evidenceRefs,
        ...(contextual
          ? {
              contextualAssessmentReference: `contextual:${verificationAttemptId}`,
            }
          : {}),
        createdAt: this.deps.clock.nowIso(),
      });

      let completionRecordId: string | undefined;
      const liveRun = await this.deps.runs.getById(runId);
      if (!liveRun) {
        throw new VerificationError(
          "VERIFICATION_PERSISTENCE_FAILED",
          "Run disappeared during verification",
        );
      }

      if (contained) {
        await this.outcomes.append(record);
        await this.appendEvent(runId, "VERIFICATION_DECIDED", {
          outcomeVerificationId,
          outcome,
        });
        // May record verification but NOT → COMPLETED
        await this.appendEvent(runId, "VERIFICATION_ESCALATED", {
          reason: "CONTAINED",
          outcome,
        });
      } else if (outcome === "VERIFIED_SUCCESS") {
        completionRecordId = await withOptionalTransaction(
          this.transactions,
          async () => {
            await this.outcomes.append(record);
            await this.deps.completionFailpoint?.hit("AFTER_OUTCOME_RECORD");
            await this.appendEvent(runId, "VERIFICATION_DECIDED", {
              outcomeVerificationId,
              outcome,
            });
            const nextCompletionRecordId =
              this.identities.nextCompletionRecordId();
            const completion = parseCompletionRecord({
              completionRecordId: nextCompletionRecordId,
              runId,
              objectiveId: objective.objectiveId,
              objectiveVersion: objective.objectiveVersion,
              planId: plan.planId,
              planVersion: plan.planVersion,
              planHash: plan.planHash,
              executionAttemptId: result.executionAttemptId,
              authorizationRecordId: auth.authorizationRecordId,
              outcomeVerificationId,
              postExecutionSnapshotHash,
              verificationSpecificationHash:
                specification.verificationSpecificationHash,
              completedAt: this.deps.clock.nowIso(),
            });
            await this.completions.append(completion);
            await this.deps.completionFailpoint?.hit("AFTER_COMPLETION_RECORD");
            await commitRunTransition(
              this.deps.runs,
              liveRun,
              "COMPLETED",
              this.deps.clock.nowIso(),
            );
            await this.deps.completionFailpoint?.hit("AFTER_RUN_TRANSITION");
            await this.appendEvent(runId, "COMPLETION_RECORDED", {
              completionRecordId: nextCompletionRecordId,
            });
            await this.deps.completionFailpoint?.hit("AFTER_EVENT_APPEND");
            return nextCompletionRecordId;
          },
        );
      } else {
        await this.outcomes.append(record);
        await this.appendEvent(runId, "VERIFICATION_DECIDED", {
          outcomeVerificationId,
          outcome,
        });
        await commitRunTransition(
          this.deps.runs,
          liveRun,
          "ESCALATED",
          this.deps.clock.nowIso(),
          { failureReasonCode: outcome },
        );
        await this.appendEvent(runId, "VERIFICATION_ESCALATED", {
          outcome,
        });
      }

      const verificationResult = parseVerificationResult({
        runId,
        executionAttemptId: result.executionAttemptId,
        verificationAttemptId,
        outcomeVerificationId,
        outcome,
        criterionResults: deterministic.criterionResults,
        postconditionResults: deterministic.postconditionResults,
        evidenceRefs,
        findings: allFindings,
        postExecutionSnapshotHash,
        verificationSpecificationHash:
          specification.verificationSpecificationHash,
        ...(completionRecordId !== undefined
          ? { completionRecordId }
          : {}),
        requiresHumanReview: outcome !== "VERIFIED_SUCCESS",
        ...(outcome !== "VERIFIED_SUCCESS"
          ? {
              failureSummary: `Outcome ${outcome}: ${decision.reasonCodes.join(", ")}`,
            }
          : {}),
      });

      await this.coordinator.storeResult(fenceKey, verificationResult);
      await this.coordinator.markDecided(
        fenceKey,
        ownerToken,
        this.deps.clock.nowIso(),
        { outcomeVerificationId, outcome },
      );
      this.resultsByRun.set(runId, verificationResult);
      return verificationResult;
    } catch (error) {
      const code = isVerificationError(error)
        ? error.code
        : "VERIFICATION_FENCE_FAILED";
      await this.coordinator.markFailed(
        fenceKey,
        ownerToken,
        this.deps.clock.nowIso(),
        code,
      );
      throw error;
    }
  }

  async getLatestResult(runId: string): Promise<VerificationResult | null> {
    const cached = this.resultsByRun.get(runId);
    if (cached) return cached;
    const record = await this.outcomes.getLatestByRun(runId);
    if (!record) return null;
    const completion = await this.completions.getByRun(runId);
    return parseVerificationResult({
      runId: record.runId,
      executionAttemptId: record.executionAttemptId,
      verificationAttemptId: record.verificationAttemptId,
      outcomeVerificationId: record.outcomeVerificationId,
      outcome: record.outcome,
      criterionResults: record.criterionResults,
      postconditionResults: record.postconditionResults,
      evidenceRefs: record.evidenceRefs,
      findings: record.findings,
      postExecutionSnapshotHash: record.postExecutionSnapshotHash,
      verificationSpecificationHash: record.verificationSpecificationHash,
      ...(completion
        ? { completionRecordId: completion.completionRecordId }
        : {}),
      requiresHumanReview: record.outcome !== "VERIFIED_SUCCESS",
    });
  }

  async listEvidence(runId: string) {
    return this.evidence.listByRun(runId);
  }

  async getCompletion(runId: string) {
    return this.completions.getByRun(runId);
  }

  private async runContextualModel(input: {
    runId: string;
    verificationAttemptId: string;
    objective: {
      objectiveId: string;
      objectiveVersion: number;
      requestedOutcome: string;
      acceptanceCriteria: readonly string[];
      constraints: readonly string[];
      nonGoals: readonly string[];
    };
    plan: { planId: string; planVersion: number; planHash: string; steps: { expectedPostconditions: string[] }[] };
    snapshot: import("../domain/verification/index.js").PostExecutionSnapshot;
    deterministic: Awaited<
      ReturnType<DeterministicOutcomeVerificationService["verify"]>
    >;
  }) {
    const reservedTokens = 500;
    const recordId = `ver_inf_${input.verificationAttemptId}`;

    if (this.deps.controlPlane) {
      try {
        const run = await this.deps.runs.getById(input.runId);
        if (run) {
          const ctx = await this.deps.controlPlane.resolve(
            run.projectId,
            run.requestedEnvironment,
          );
          await this.inferenceBudget.assertCanReserve({
            runId: input.runId,
            budget: ctx.resourceBudget,
            reservedTokens,
          });
        }
      } catch (error) {
        if (
          isVerificationError(error) &&
          error.code === "VERIFICATION_RESOURCE_BUDGET_EXCEEDED"
        ) {
          // Deterministic result continues; ambiguity → INCONCLUSIVE via missing contextual
          return undefined;
        }
        // Control plane resolve failure: skip model
        return undefined;
      }
    }

    await this.inferenceLedger.reserve({
      recordId,
      runId: input.runId,
      verificationAttemptId: input.verificationAttemptId,
      provider: this.model.provider,
      model: this.model.modelId,
      reservedTokens,
      nowIso: this.deps.clock.nowIso(),
    });

    try {
      await this.inferenceLedger.markDispatched?.(recordId);
      const contextualInput = parseContextualOutcomeInput({
        runId: input.runId,
        objectiveId: input.objective.objectiveId,
        objectiveVersion: input.objective.objectiveVersion,
        requestedOutcome: input.objective.requestedOutcome,
        acceptanceCriteria: [...input.objective.acceptanceCriteria],
        constraints: [...input.objective.constraints],
        nonGoals: [...input.objective.nonGoals],
        planId: input.plan.planId,
        planVersion: input.plan.planVersion,
        planHash: input.plan.planHash,
        postExecutionSnapshot: input.snapshot,
        evidence: input.deterministic.evidence,
        criterionResults: input.deterministic.criterionResults,
        postconditionResults: input.deterministic.postconditionResults,
        findings: input.deterministic.findings,
        expectedPostconditions: input.plan.steps.flatMap(
          (s) => s.expectedPostconditions,
        ),
      });

      await this.appendEvent(input.runId, "VERIFICATION_MODEL_CALLED", {
        provider: this.model.provider,
        model: this.model.modelId,
      });

      const output = await (async () => {
        assertNotInTransaction("VerificationModel");
        return this.model.assessOutcome(contextualInput);
      })();
      const usage = output.usage;
      if (usage) {
        await this.inferenceLedger.settle({
          recordId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          nowIso: this.deps.clock.nowIso(),
        });
      } else {
        await this.inferenceLedger.chargeAmbiguous(
          recordId,
          this.deps.clock.nowIso(),
        );
      }
      return output.value;
    } catch (error) {
      if (isVerificationPreDispatchError(error)) {
        await this.inferenceLedger.release(
          recordId,
          this.deps.clock.nowIso(),
        );
        return undefined;
      }
      await this.inferenceLedger.chargeAmbiguous(
        recordId,
        this.deps.clock.nowIso(),
      );
      return undefined;
    }
  }

  private async appendEvent(
    runId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.events) return;
    const run = await this.deps.runs.getById(runId);
    if (!run) return;
    const now = this.deps.clock.nowIso();
    const eventId = this.identities.nextEventId();
    await this.deps.events.append({
      eventId,
      eventType,
      eventVersion: "1",
      runId,
      correlationId: run.correlationId,
      causationId: run.runId,
      idempotencyKey: `${eventType}:${runId}:${eventId}`,
      projectId: run.projectId,
      objectiveId: run.objectiveId,
      objectiveVersion: run.objectiveVersion,
      traceId: run.traceId,
      createdAt: now,
      expiresAt: now,
      schemaVersion: "1",
      data,
    });
  }
}
