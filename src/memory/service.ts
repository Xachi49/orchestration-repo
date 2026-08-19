import type { ClockPort } from "../infrastructure/clock.js";
import { assertNotInTransaction } from "../durability/transaction.js";
import type { RunRepository } from "../admission/run-repository.js";
import type { ObjectiveRepository } from "../admission/objective-repository.js";
import type { PlanRepository } from "../planning/plan-repository.js";
import type { AuthorizationRecordRepository } from "../authorization/authorization-record-repository.js";
import type { ExecutionService } from "../execution/service.js";
import type { OutcomeVerificationRepository } from "../verification/outcome-repository.js";
import type { CompletionRecordRepository } from "../verification/completion-repository.js";
import type { VerificationEvidenceRepository } from "../verification/evidence-repository.js";
import type { ControlPlaneService } from "../control-plane/service.js";
import type { VerifiedRepositoryContextStore } from "../ingestion/context.js";
import { objectiveFingerprint } from "../domain/objective/fingerprint.js";
import { hashCanonical } from "../ingestion/hashing.js";
import {
  isLearnableTerminalRunState,
  type HistoricalOutcome,
  type HistoricalRunRecord,
  type GovernedMemoryResult,
  type MemoryQualityFinding,
  type LearningCandidate,
  type PromotedPrecedent,
} from "../domain/memory/index.js";
import { MemoryError, isLearningPreDispatchError } from "./errors.js";
import {
  SequenceMemoryIdentityGenerator,
  type MemoryIdentityGenerator,
} from "./identity.js";
import { HistoricalRunRecordHasher, CandidateHasher, ProvenanceHasher, PrecedentHasher } from "./hasher.js";
import {
  polarityForCandidateType,
  type LearningClaim,
} from "../domain/memory/claim.js";
import { LearningClaimGroundingService } from "./grounding.js";
import { containsAuthorityLikeLanguage } from "./extraction.js";
import type { LearningModelSuggestion } from "./model.js";
import {
  InMemoryLearningCoordinator,
  type LearningCoordinator,
  type LearningFenceKey,
} from "./coordinator.js";
import type { HistoricalRunRepository } from "./historical-run-repository.js";
import { InMemoryHistoricalRunRepository } from "./historical-run-repository.js";
import type { LearningCandidateRepository } from "./candidate-repository.js";
import { InMemoryLearningCandidateRepository } from "./candidate-repository.js";
import type { PromotedPrecedentRepository } from "./promoted-precedent-repository.js";
import { InMemoryPromotedPrecedentRepository } from "./promoted-precedent-repository.js";
import type { PrecedentPromotionDecisionRepository } from "./promotion-decision-repository.js";
import { InMemoryPrecedentPromotionDecisionRepository } from "./promotion-decision-repository.js";
import type { LearningLedgerRepository } from "./ledger-repository.js";
import { InMemoryLearningLedgerRepository } from "./ledger-repository.js";
import type { PrecedentContradictionRepository } from "./contradiction-repository.js";
import { InMemoryPrecedentContradictionRepository } from "./contradiction-repository.js";
import { LearningExtractionService } from "./extraction.js";
import type { LearningModel } from "./model.js";
import { FakeLearningModel } from "./fake-model.js";
import {
  InMemoryLearningInferenceLedger,
  LearningInferenceBudget,
  type LearningInferenceLedger,
} from "./inference-ledger.js";
import { DEFAULT_PROMOTION_POLICY } from "./promotion-policy.js";
import type { PrecedentPromotionPolicy } from "../domain/memory/promotion.js";
import { PrecedentPromotionReadinessService } from "./promotion-readiness.js";
import { PrecedentPromotionService } from "./promotion.js";
import { PrecedentContradictionService } from "./contradiction.js";
import { PrecedentCorroborationService } from "./corroboration.js";
import { PrecedentIntegrityService } from "./integrity.js";
import {
  PrecedentRetriever,
  type PrecedentRetrievalQuery,
  type PrecedentRetrievalResult,
} from "./retriever.js";
import type { PrecedentApplicability } from "../domain/memory/applicability.js";
import { assertProjectScope } from "../domain/project-scope.js";

export interface GovernedMemoryServiceDeps {
  runs: RunRepository;
  objectives: ObjectiveRepository;
  plans: PlanRepository;
  authorizationRecords: AuthorizationRecordRepository;
  execution: ExecutionService;
  outcomes: OutcomeVerificationRepository;
  completions: CompletionRecordRepository;
  evidence?: VerificationEvidenceRepository;
  contexts?: VerifiedRepositoryContextStore;
  controlPlane?: ControlPlaneService;
  clock: ClockPort;
  coordinator?: LearningCoordinator;
  historicalRuns?: HistoricalRunRepository;
  candidates?: LearningCandidateRepository;
  precedents?: PromotedPrecedentRepository;
  decisions?: PrecedentPromotionDecisionRepository;
  ledger?: LearningLedgerRepository;
  contradictions?: PrecedentContradictionRepository;
  model?: LearningModel;
  inferenceLedger?: LearningInferenceLedger;
  identities?: MemoryIdentityGenerator;
  policy?: PrecedentPromotionPolicy;
  enableLearningModel?: boolean;
  transactions?: import("../durability/transaction.js").TransactionManager;
  promotionFailpoint?: import("./promotion.js").PromotionFailpoint;
}

/**
 * Phase 9 governed memory orchestration.
 *
 * HISTORICAL DATA ≠ TRUSTED PRECEDENT ≠ POLICY ≠ AUTHORIZATION ≠ CURRENT TRUTH
 * LearningModel NEVER promotes. Callers cannot create PromotedPrecedent directly.
 */
export class GovernedMemoryService {
  private readonly identities: MemoryIdentityGenerator;
  private readonly coordinator: LearningCoordinator;
  private readonly historicalRuns: HistoricalRunRepository;
  private readonly candidates: LearningCandidateRepository;
  private readonly precedents: PromotedPrecedentRepository;
  private readonly decisions: PrecedentPromotionDecisionRepository;
  private readonly ledger: LearningLedgerRepository;
  private readonly contradictions: PrecedentContradictionRepository;
  private readonly model: LearningModel;
  private readonly inferenceLedger: LearningInferenceLedger;
  private readonly inferenceBudget: LearningInferenceBudget;
  private readonly extraction: LearningExtractionService;
  private readonly historicalHasher = new HistoricalRunRecordHasher();
  private readonly candidateHasher = new CandidateHasher();
  private readonly provenanceHasher = new ProvenanceHasher();
  private readonly claimGrounding = new LearningClaimGroundingService();
  private readonly policy: PrecedentPromotionPolicy;
  private readonly readiness: PrecedentPromotionReadinessService;
  private readonly promotion: PrecedentPromotionService;
  private readonly contradictionService: PrecedentContradictionService;
  private readonly corroboration: PrecedentCorroborationService;
  private readonly integrity: PrecedentIntegrityService;
  private readonly retriever: PrecedentRetriever;
  private readonly enableLearningModel: boolean;
  private readonly resultsByRun = new Map<string, GovernedMemoryResult>();
  private readonly precedentHasher = new PrecedentHasher();

  constructor(private readonly deps: GovernedMemoryServiceDeps) {
    this.identities =
      deps.identities ?? new SequenceMemoryIdentityGenerator();
    this.coordinator =
      deps.coordinator ?? new InMemoryLearningCoordinator();
    this.historicalRuns =
      deps.historicalRuns ?? new InMemoryHistoricalRunRepository();
    this.candidates =
      deps.candidates ?? new InMemoryLearningCandidateRepository();
    this.precedents =
      deps.precedents ?? new InMemoryPromotedPrecedentRepository();
    this.decisions =
      deps.decisions ?? new InMemoryPrecedentPromotionDecisionRepository();
    this.ledger = deps.ledger ?? new InMemoryLearningLedgerRepository();
    this.contradictions =
      deps.contradictions ?? new InMemoryPrecedentContradictionRepository();
    this.model = deps.model ?? new FakeLearningModel();
    this.inferenceLedger =
      deps.inferenceLedger ?? new InMemoryLearningInferenceLedger();
    this.inferenceBudget = new LearningInferenceBudget(this.inferenceLedger);
    this.extraction = new LearningExtractionService(this.identities);
    this.policy = deps.policy ?? DEFAULT_PROMOTION_POLICY;
    this.enableLearningModel = deps.enableLearningModel !== false;

    this.readiness = new PrecedentPromotionReadinessService({
      identities: this.identities,
      ...(deps.evidence !== undefined ? { evidence: deps.evidence } : {}),
      nowIso: () => this.deps.clock.nowIso(),
    });
    this.promotion = new PrecedentPromotionService({
      readiness: this.readiness,
      candidates: this.candidates,
      precedents: this.precedents,
      decisions: this.decisions,
      historicalRuns: this.historicalRuns,
      contradictions: this.contradictions,
      ledger: this.ledger,
      identities: this.identities,
      policy: this.policy,
      nowIso: () => this.deps.clock.nowIso(),
      outcomes: this.deps.outcomes,
      ...(this.deps.transactions !== undefined
        ? { transactions: this.deps.transactions }
        : {}),
      ...(this.deps.promotionFailpoint !== undefined
        ? { promotionFailpoint: this.deps.promotionFailpoint }
        : {}),
    });
    this.contradictionService = new PrecedentContradictionService({
      contradictions: this.contradictions,
      ledger: this.ledger,
      identities: this.identities,
      nowIso: () => this.deps.clock.nowIso(),
    });
    this.corroboration = new PrecedentCorroborationService({
      precedents: this.precedents,
      ledger: this.ledger,
      identities: this.identities,
      nowIso: () => this.deps.clock.nowIso(),
    });
    this.integrity = new PrecedentIntegrityService({
      historicalRuns: this.historicalRuns,
      contradictions: this.contradictions,
    });
    this.retriever = new PrecedentRetriever({
      precedents: this.precedents,
      contradictions: this.contradictions,
      integrity: this.integrity,
      ledger: this.ledger,
      identities: this.identities,
      nowIso: () => this.deps.clock.nowIso(),
    });
  }

  getRetriever(): PrecedentRetriever {
    return this.retriever;
  }

  getPrecedents(): PromotedPrecedentRepository {
    return this.precedents;
  }

  getCandidates(): LearningCandidateRepository {
    return this.candidates;
  }

  getHistoricalRuns(): HistoricalRunRepository {
    return this.historicalRuns;
  }

  getLedger(): LearningLedgerRepository {
    return this.ledger;
  }

  getContradictions(): PrecedentContradictionRepository {
    return this.contradictions;
  }

  getIntegrity(): PrecedentIntegrityService {
    return this.integrity;
  }

  getCorroboration(): PrecedentCorroborationService {
    return this.corroboration;
  }

  getPromotion(): PrecedentPromotionService {
    return this.promotion;
  }

  async learn(runId: string): Promise<GovernedMemoryResult> {
    const prior = this.resultsByRun.get(runId);
    if (prior) {
      return prior;
    }

    const run = await this.deps.runs.getById(runId);
    if (!run) {
      throw new MemoryError("LEARNING_NOT_READY", `Run not found: ${runId}`);
    }
    if (!isLearnableTerminalRunState(run.state)) {
      throw new MemoryError(
        "LEARNING_RUN_NOT_TERMINAL",
        `Run state ${run.state} is not learnable`,
        { runId, state: run.state },
      );
    }

    const outcome = await this.resolveOutcome(runId, run.state);
    const fenceKey: LearningFenceKey = {
      runId,
      outcome: outcome.outcome,
      ...(outcome.outcomeVerificationId !== undefined
        ? { outcomeVerificationId: outcome.outcomeVerificationId }
        : {}),
    };

    const begin = await this.coordinator.begin(
      fenceKey,
      this.deps.clock.nowIso(),
    );
    if (begin.outcome === "IN_PROGRESS") {
      throw new MemoryError(
        "LEARNING_IN_PROGRESS",
        "Learning already in progress",
        { runId },
      );
    }
    if (begin.outcome === "ALREADY_PROCESSED") {
      const existing = await this.historicalRuns.getByRunId(runId);
      if (existing) {
        const result = await this.buildResultFromExisting(runId, existing);
        this.resultsByRun.set(runId, result);
        return result;
      }
    }

    if (begin.outcome !== "STARTED") {
      throw new MemoryError(
        "LEARNING_FENCE_FAILED",
        `Unexpected learning fence outcome: ${begin.outcome}`,
        { runId },
      );
    }

    const ownerToken = begin.ownerToken;
    try {
      const historical = await this.ensureHistoricalRunRecord(
        runId,
        run,
        outcome,
      );
      const verification =
        historical.outcomeVerificationId !== undefined
          ? await this.deps.outcomes.getById(historical.outcomeVerificationId)
          : null;

      let candidates = this.extraction.extract({
        historicalRun: historical,
        verification,
        nowIso: this.deps.clock.nowIso(),
      });

      // Optional model suggestions — never promote; may add advisory candidates
      if (this.enableLearningModel) {
        candidates = await this.mergeModelSuggestions(
          historical,
          candidates,
        );
      }

      const persisted: LearningCandidate[] = [];
      for (const candidate of candidates) {
        const saved = await this.candidates.append(candidate);
        if (
          !persisted.some(
            (p) => p.learningCandidateId === saved.learningCandidateId,
          )
        ) {
          persisted.push(saved);
          await this.ledger.append({
            eventId: this.identities.nextLedgerEventId(),
            eventType: "LEARNING_CANDIDATE_CREATED",
            runId,
            projectId: saved.projectId,
            historicalRunRecordId: historical.historicalRunRecordId,
            learningCandidateId: saved.learningCandidateId,
            payload: {
              candidateType: saved.candidateType,
              candidateHash: saved.candidateHash,
              origin: saved.origin,
              groundingVerdict: saved.grounding.verdict,
            },
            createdAt: this.deps.clock.nowIso(),
          });
        }
      }

      const activePrecedents = await this.precedents.listActiveByProject(
        historical.projectId,
      );
      const qualityFindings: MemoryQualityFinding[] = [];
      const contradictionIds: string[] = [];
      const promotedPrecedentIds: string[] = [];
      const reviewRequiredCandidateIds: string[] = [];

      for (const candidate of persisted) {
        if (candidate.status === "PROMOTED" || candidate.status === "REJECTED") {
          continue;
        }
        const contradictions =
          await this.contradictionService.detectForCandidate(
            candidate,
            activePrecedents,
          );
        for (const c of contradictions) {
          contradictionIds.push(c.contradictionId);
        }

        const attempt = await this.promotion.tryAutoPromote(candidate);
        qualityFindings.push(...attempt.findings);
        if (attempt.promoted) {
          promotedPrecedentIds.push(attempt.promoted.precedentId);
        } else if (attempt.reviewRequired) {
          reviewRequiredCandidateIds.push(candidate.learningCandidateId);
        }
      }

      await this.coordinator.markProcessed(
        fenceKey,
        ownerToken,
        this.deps.clock.nowIso(),
        historical.historicalRunRecordId,
      );

      const result: GovernedMemoryResult = {
        runId,
        historicalRunRecordId: historical.historicalRunRecordId,
        candidateIds: persisted.map((c) => c.learningCandidateId).sort(),
        promotedPrecedentIds: [...new Set(promotedPrecedentIds)].sort(),
        reviewRequiredCandidateIds: [
          ...new Set(reviewRequiredCandidateIds),
        ].sort(),
        contradictionIds: [...new Set(contradictionIds)].sort(),
        qualityFindings,
        processedAt: this.deps.clock.nowIso(),
      };
      this.resultsByRun.set(runId, result);
      return result;
    } catch (error) {
      const code =
        error instanceof MemoryError ? error.code : "LEARNING_PERSISTENCE_FAILED";
      await this.coordinator.markFailed(
        fenceKey,
        ownerToken,
        this.deps.clock.nowIso(),
        code,
      );
      throw error;
    }
  }

  async getLatestResult(runId: string): Promise<GovernedMemoryResult | null> {
    return this.resultsByRun.get(runId) ?? null;
  }

  async listLearnings(runId: string): Promise<{
    historicalRun: HistoricalRunRecord | null;
    candidates: readonly LearningCandidate[];
    result: GovernedMemoryResult | null;
  }> {
    const historicalRun = await this.historicalRuns.getByRunId(runId);
    const candidates = historicalRun
      ? await this.candidates.listByRunRecord(
          historicalRun.historicalRunRecordId,
        )
      : [];
    return {
      historicalRun,
      candidates,
      result: this.resultsByRun.get(runId) ?? null,
    };
  }

  async listProjectPrecedents(
    projectId: string,
  ): Promise<readonly PromotedPrecedent[]> {
    return this.precedents.listByProject(projectId);
  }

  async getPrecedent(precedentId: string): Promise<PromotedPrecedent | null> {
    return this.precedents.getById(precedentId);
  }

  async getPrecedentInProject(
    precedentId: string,
    projectId: string,
  ): Promise<PromotedPrecedent | null> {
    const precedent = await this.precedents.getById(precedentId);
    if (!precedent) {
      return null;
    }
    assertProjectScope(
      precedent.projectId,
      projectId,
      "precedent",
      precedentId,
    );
    return precedent;
  }

  async reviewCandidate(input: {
    learningCandidateId: string;
    reviewerId: string;
    decision: "PROMOTE" | "REJECT" | "REQUEST_NARROWER_SCOPE";
    approvedApplicability?: PrecedentApplicability;
    note?: string;
  }): Promise<{
    decision: Awaited<
      ReturnType<PrecedentPromotionService["applyHumanDecision"]>
    >["decision"];
    promoted?: PromotedPrecedent;
  }> {
    return this.promotion.applyHumanDecision(input);
  }

  async retrievePrecedents(
    query: PrecedentRetrievalQuery,
  ): Promise<PrecedentRetrievalResult> {
    return this.retriever.retrieve(query);
  }

  async supersedePrecedent(input: {
    oldPrecedentId: string;
    newStatement: string;
    reason: string;
  }): Promise<PromotedPrecedent> {
    const old = await this.precedents.getById(input.oldPrecedentId);
    if (!old) {
      throw new MemoryError(
        "PRECEDENT_NOT_FOUND",
        `Precedent not found: ${input.oldPrecedentId}`,
      );
    }
    if (old.grounding.verdict === "UNGROUNDED") {
      throw new MemoryError(
        "PROMOTION_GROUNDING_INSUFFICIENT",
        "UNGROUNDED sources cannot supersede or author a precedent",
      );
    }
    const createdAt = this.deps.clock.nowIso();
    const draft = {
      precedentId: old.precedentId,
      version: old.version + 1,
      candidateId: old.candidateId,
      candidateHash: old.candidateHash,
      projectId: old.projectId,
      candidateType: old.candidateType,
      origin: old.origin,
      claim: old.claim,
      grounding: old.grounding,
      statement: input.newStatement,
      applicability: old.applicability,
      provenance: old.provenance,
      sourceOutcome: old.sourceOutcome,
      trustClass: old.trustClass,
      promotionMethod: old.promotionMethod,
      ...(old.promotionDecisionId !== undefined
        ? { promotionDecisionId: old.promotionDecisionId }
        : {}),
      supersedesPrecedentIds: [`${old.precedentId}:v${old.version}`],
    };
    const next: PromotedPrecedent = {
      ...draft,
      createdAt,
      precedentHash: this.precedentHasher.hash(draft),
      status: "ACTIVE",
      label: "ADVISORY_PRECEDENT",
    };
    await this.precedents.updateStatus(old.precedentId, old.version, "SUPERSEDED");
    await this.precedents.append(next);
    await this.ledger.append({
      eventId: this.identities.nextLedgerEventId(),
      eventType: "PRECEDENT_SUPERSEDED",
      projectId: old.projectId,
      precedentId: old.precedentId,
      payload: {
        reason: input.reason,
        fromVersion: old.version,
        toVersion: next.version,
      },
      createdAt,
    });
    return next;
  }

  async retirePrecedent(
    precedentId: string,
    reason: string,
  ): Promise<PromotedPrecedent> {
    const existing = await this.precedents.getById(precedentId);
    if (!existing) {
      throw new MemoryError(
        "PRECEDENT_NOT_FOUND",
        `Precedent not found: ${precedentId}`,
      );
    }
    const retired = await this.precedents.updateStatus(
      existing.precedentId,
      existing.version,
      "RETIRED",
    );
    await this.ledger.append({
      eventId: this.identities.nextLedgerEventId(),
      eventType: "PRECEDENT_RETIRED",
      projectId: existing.projectId,
      precedentId,
      payload: { reason, version: existing.version },
      createdAt: this.deps.clock.nowIso(),
    });
    return retired;
  }

  /** Test helper: compute historical record hash for identity material. */
  hashHistoricalDraft(
    draft: Omit<HistoricalRunRecord, "recordHash" | "startedAt" | "finishedAt">,
  ): string {
    return this.historicalHasher.hash(draft);
  }

  private async resolveOutcome(
    runId: string,
    runState: string,
  ): Promise<{
    outcome: HistoricalOutcome;
    outcomeVerificationId?: string;
    completionRecordId?: string;
  }> {
    const verification = await this.deps.outcomes.getLatestByRun(runId);
    const completion = await this.deps.completions.getByRun(runId);

    if (verification) {
      return {
        outcome: verification.outcome as HistoricalOutcome,
        outcomeVerificationId: verification.outcomeVerificationId,
        ...(completion
          ? { completionRecordId: completion.completionRecordId }
          : {}),
      };
    }

    // Governance terminals without verification
    const mapped: Record<string, HistoricalOutcome> = {
      BLOCKED: "BLOCKED",
      REJECTED: "REJECTED",
      EXPIRED: "EXPIRED",
      ESCALATED: "ESCALATED",
      CONTAINED: "CONTAINED",
    };
    const outcome = mapped[runState];
    if (!outcome) {
      if (runState === "COMPLETED") {
        throw new MemoryError(
          "LEARNING_OUTCOME_MISSING",
          "COMPLETED run missing OutcomeVerificationRecord",
          { runId },
        );
      }
      throw new MemoryError(
        "LEARNING_OUTCOME_MISSING",
        `Cannot resolve historical outcome for ${runState}`,
        { runId },
      );
    }
    return { outcome };
  }

  private async ensureHistoricalRunRecord(
    runId: string,
    run: NonNullable<Awaited<ReturnType<RunRepository["getById"]>>>,
    outcome: {
      outcome: HistoricalOutcome;
      outcomeVerificationId?: string;
      completionRecordId?: string;
    },
  ): Promise<HistoricalRunRecord> {
    const existing = await this.historicalRuns.getByOutcomeIdentity({
      runId,
      outcome: outcome.outcome,
      ...(outcome.outcomeVerificationId !== undefined
        ? { outcomeVerificationId: outcome.outcomeVerificationId }
        : {}),
    });
    if (existing) {
      return existing;
    }

    const objective = await this.deps.objectives.getByRunBinding(runId);
    if (!objective) {
      throw new MemoryError(
        "LEARNING_NOT_READY",
        `Objective not found for run ${runId}`,
      );
    }
    const planRecord = await this.deps.plans.getByRunId(runId);
    const auth = await this.deps.authorizationRecords.getLatestByRun(runId);
    const execution = await this.deps.execution.getLatestResult(runId);
    const context = this.deps.contexts
      ? await this.deps.contexts.getByRunId(runId)
      : null;

    const objFp = objectiveFingerprint({
      requestedOutcome: objective.requestedOutcome,
      acceptanceCriteria: objective.acceptanceCriteria,
      constraints: objective.constraints,
      nonGoals: objective.nonGoals,
      priority: objective.priority,
      ...(objective.deadline !== undefined
        ? { deadline: objective.deadline }
        : {}),
    });

    const planSteps = planRecord?.plan.steps ?? [];
    const actionTypes = [
      ...new Set(planSteps.map((s) => s.actionType)),
    ].sort();

    let policyBundleHash: string | undefined;
    let capabilityIds: string[] = [];
    if (this.deps.controlPlane) {
      try {
        const control = await this.deps.controlPlane.resolve(
          run.projectId,
          run.requestedEnvironment,
        );
        policyBundleHash = control.activePolicyBundle.policyHash;
        capabilityIds = control.availableCapabilities
          .filter((cap) =>
            actionTypes.some((action) => cap.allowedActions.includes(action)),
          )
          .map((cap) => cap.capabilityId)
          .sort();
      } catch {
        policyBundleHash = undefined;
      }
    }
    const capabilitySetFingerprint =
      capabilityIds.length > 0
        ? hashCanonical({ capabilityIds })
        : undefined;

    const historicalRunRecordId = this.identities.nextHistoricalRunRecordId();
    const draft = {
      historicalRunRecordId,
      runId,
      projectId: run.projectId,
      objectiveId: run.objectiveId,
      objectiveVersion: run.objectiveVersion,
      objectiveFingerprint: objFp,
      ...(planRecord
        ? {
            planId: planRecord.planId,
            planVersion: planRecord.planVersion,
            planHash: planRecord.planHash,
          }
        : {}),
      ...(auth ? { authorizationRecordId: auth.authorizationRecordId } : {}),
      ...(execution
        ? { executionAttemptId: execution.executionAttemptId }
        : {}),
      ...(outcome.outcomeVerificationId !== undefined
        ? { outcomeVerificationId: outcome.outcomeVerificationId }
        : {}),
      ...(outcome.completionRecordId !== undefined
        ? { completionRecordId: outcome.completionRecordId }
        : {}),
      outcome: outcome.outcome,
      runState: run.state,
      ...(context
        ? { repositoryFingerprint: context.repositoryFingerprint }
        : {}),
      ...(policyBundleHash !== undefined ? { policyBundleHash } : {}),
      ...(capabilitySetFingerprint !== undefined
        ? { capabilitySetFingerprint }
        : {}),
      environment: run.requestedEnvironment,
      actionTypes,
      capabilityIds,
    };

    const record: HistoricalRunRecord = {
      ...draft,
      recordHash: this.historicalHasher.hash(draft),
      finishedAt: this.deps.clock.nowIso(),
    };

    const saved = await this.historicalRuns.append(record);
    if (saved.historicalRunRecordId === historicalRunRecordId) {
      await this.ledger.append({
        eventId: this.identities.nextLedgerEventId(),
        eventType: "HISTORICAL_RUN_RECORDED",
        runId,
        projectId: run.projectId,
        historicalRunRecordId: saved.historicalRunRecordId,
        payload: {
          outcome: saved.outcome,
          recordHash: saved.recordHash,
        },
        createdAt: this.deps.clock.nowIso(),
      });
    }
    return saved;
  }

  private async mergeModelSuggestions(
    historical: HistoricalRunRecord,
    deterministic: LearningCandidate[],
  ): Promise<LearningCandidate[]> {
    try {
      if (this.deps.controlPlane) {
        const run = await this.deps.runs.getById(historical.runId);
        if (run) {
          const control = await this.deps.controlPlane.resolve(
            run.projectId,
            run.requestedEnvironment,
          );
          await this.inferenceBudget.assertCanReserve({
            runId: historical.runId,
            budget: control.resourceBudget,
            reservedTokens: 512,
          });
        }
      }
    } catch (error) {
      if (
        error instanceof MemoryError &&
        error.code === "LEARNING_RESOURCE_BUDGET_EXCEEDED"
      ) {
        // Skip contextual extraction; preserve deterministic learning.
        return deterministic;
      }
      throw error;
    }

    const recordId = this.identities.nextInferenceRecordId();
    await this.inferenceLedger.reserve({
      recordId,
      runId: historical.runId,
      historicalRunRecordId: historical.historicalRunRecordId,
      provider: this.model.provider,
      model: this.model.modelId,
      reservedTokens: 512,
      nowIso: this.deps.clock.nowIso(),
    });

    try {
      await this.inferenceLedger.markDispatched?.(recordId);
      assertNotInTransaction("LearningModel");
      const assessed = await this.model.assess({
        historicalRun: historical,
        deterministicCandidates: deterministic,
      });
      const usage = assessed.usage;
      await this.inferenceLedger.settle({
        recordId,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        nowIso: this.deps.clock.nowIso(),
      });

      // MODEL_SUGGESTION candidates are persisted for review.
      // suggestedAction, including PROMOTE, has no promotion effect.
      const modelCandidates = this.materializeModelSuggestions(
        historical,
        assessed.value.suggestions,
      );
      return [...deterministic, ...modelCandidates];
    } catch (error) {
      if (isLearningPreDispatchError(error)) {
        await this.inferenceLedger.release(
          recordId,
          this.deps.clock.nowIso(),
        );
      }
      // Preserve deterministic learning on model failure.
      return deterministic;
    }
  }

  /**
   * Persist model suggestions as MODEL_SUGGESTION candidates.
   * Never auto-promotes. suggestedAction is advisory and ignored.
   */
  private materializeModelSuggestions(
    historical: HistoricalRunRecord,
    suggestions: readonly LearningModelSuggestion[],
  ): LearningCandidate[] {
    const nowIso = this.deps.clock.nowIso();
    const candidates: LearningCandidate[] = [];
    const provenanceDraft = {
      sourceHistoricalRunRecordId: historical.historicalRunRecordId,
      runId: historical.runId,
      ...(historical.planHash !== undefined ? { planHash: historical.planHash } : {}),
      ...(historical.outcomeVerificationId !== undefined
        ? { outcomeVerificationId: historical.outcomeVerificationId }
        : {}),
      outcome: historical.outcome,
      ...(historical.repositoryFingerprint !== undefined
        ? { repositoryFingerprint: historical.repositoryFingerprint }
        : {}),
      ...(historical.policyBundleHash !== undefined
        ? { policyBundleHash: historical.policyBundleHash }
        : {}),
      ...(historical.capabilitySetFingerprint !== undefined
        ? { capabilitySetFingerprint: historical.capabilitySetFingerprint }
        : {}),
      supportingEvidenceRefs: [] as string[],
      supportingFindingRefs: [] as string[],
    };
    const provenance = {
      ...provenanceDraft,
      provenanceHash: this.provenanceHasher.hash(provenanceDraft),
    };

    for (const suggestion of suggestions) {
      void suggestion.suggestedAction;
      const claim: LearningClaim = {
        candidateType: suggestion.candidateType,
        observedOutcome: historical.outcome,
        polarity: polarityForCandidateType(
          suggestion.candidateType,
          suggestion.claimedCriterionVerdicts ?? [],
        ),
        ...(historical.planHash !== undefined ? { planHash: historical.planHash } : {}),
        actionTypes: suggestion.claimedActionTypes ?? [...historical.actionTypes],
        capabilityIds:
          suggestion.claimedCapabilityIds ?? [...historical.capabilityIds],
        verificationMethods: suggestion.claimedVerificationMethods ?? [],
        criterionIds: suggestion.claimedCriterionIds ?? [],
        criterionVerdicts: suggestion.claimedCriterionVerdicts ?? [],
        findingIds: suggestion.claimedFindingIds ?? [],
        evidenceRefs: [],
        ...(suggestion.containmentReason !== undefined
          ? { containmentReason: suggestion.containmentReason }
          : suggestion.candidateType === "CONTAINMENT_PATTERN"
            ? { containmentReason: "CONTAINED" }
            : {}),
        ...(suggestion.resourceObservation !== undefined
          ? { resourceObservation: suggestion.resourceObservation }
          : {}),
      };
      const statement = suggestion.statement;
      const authorityLike = containsAuthorityLikeLanguage(statement);
      const learningCandidateId = `learn_cand_model_${hashCanonical({
        historicalRunRecordId: historical.historicalRunRecordId,
        origin: "MODEL_SUGGESTION",
        statement,
        candidateType: suggestion.candidateType,
        claim,
      }).slice(0, 16)}`;
      const grounding = this.claimGrounding.ground({
        claim,
        historicalRun: historical,
      });
      const draft = {
        learningCandidateId,
        sourceHistoricalRunRecordId: historical.historicalRunRecordId,
        projectId: historical.projectId,
        candidateType: suggestion.candidateType,
        origin: "MODEL_SUGGESTION" as const,
        claim,
        statement,
        applicabilityProposal: {
          scopeClass: suggestion.suggestedScopeClass ?? "PROJECT_LOCAL",
          projectIds: [historical.projectId],
          objectiveClasses: [] as string[],
          repositoryCharacteristics: historical.repositoryFingerprint
            ? [`fingerprint:${historical.repositoryFingerprint.slice(0, 12)}`]
            : [],
          actionTypes: [...historical.actionTypes].sort(),
          capabilityIds: [...historical.capabilityIds].sort(),
          environments: historical.environment ? [historical.environment] : [],
          executionModes: [] as string[],
          riskClasses: [suggestion.suggestedRiskClass ?? "LOW"],
          outcomeTypes: [historical.outcome],
          policyBundleCompatibility: historical.policyBundleHash
            ? [historical.policyBundleHash]
            : [],
          technologyTags: [] as string[],
        },
        provenance,
        supportingEvidenceRefs: [] as string[],
        supportingFindingRefs: [] as string[],
        sourceOutcome: historical.outcome,
        confidenceClass: "MEDIUM" as const,
        riskClass: authorityLike
          ? ("HIGH" as const)
          : (suggestion.suggestedRiskClass ?? "LOW"),
        containsAuthorityLikeLanguage: authorityLike,
      };
      candidates.push({
        ...draft,
        grounding,
        createdAt: nowIso,
        candidateHash: this.candidateHasher.hash(draft),
        status: "CANDIDATE",
      });
    }
    return candidates;
  }

  private async buildResultFromExisting(
    runId: string,
    historical: HistoricalRunRecord,
  ): Promise<GovernedMemoryResult> {
    const candidates = await this.candidates.listByRunRecord(
      historical.historicalRunRecordId,
    );
    const promoted = candidates
      .filter((c) => c.status === "PROMOTED")
      .map((c) => c.learningCandidateId);
    const review = candidates
      .filter((c) => c.status === "CANDIDATE")
      .map((c) => c.learningCandidateId);
    return {
      runId,
      historicalRunRecordId: historical.historicalRunRecordId,
      candidateIds: candidates.map((c) => c.learningCandidateId).sort(),
      promotedPrecedentIds: promoted.sort(),
      reviewRequiredCandidateIds: review.sort(),
      contradictionIds: [],
      qualityFindings: [],
      processedAt: this.deps.clock.nowIso(),
    };
  }
}
