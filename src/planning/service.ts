import { randomUUID } from "node:crypto";
import { assertNotInTransaction } from "../durability/transaction.js";
import { assertTransition } from "../domain/run/run-state.js";
import {
  type RunRepository,
} from "../admission/run-repository.js";
import { commitRunTransition } from "../admission/run-transition.js";
import type { ObjectiveRepository } from "../admission/objective-repository.js";
import type { ControlPlaneService } from "../control-plane/service.js";
import type { ControlPlaneClock } from "../control-plane/service.js";
import type { CapabilityRegistry } from "../control-plane/capabilities/registry.js";
import type { ResourceBudgetProfile } from "../control-plane/budgets/budget.js";
import type {
  EvidenceRegistry,
  LockedRepositoryStore,
  RepositoryWorkspaceService,
  VerifiedRepositoryContextStore,
} from "../ingestion/index.js";
import type { CommitSha } from "../ingestion/remote-repository.js";
import { INITIAL_PLAN_VERSION } from "../domain/plan/execution-plan.js";
import { PlanningReadinessService } from "./readiness.js";
import type { PlanningCoordinator } from "./coordinator.js";
import { ContextBudgetController } from "./budget-controller.js";
import { EvidenceReferenceValidator } from "./evidence-ref-validator.js";
import { CapabilityReferenceValidator } from "./capability-ref-validator.js";
import { DependencyGraphService } from "./dependency-graph.js";
import { PlanResourceAnalyzer } from "./resource-analyzer.js";
import { PlanQualityScorer } from "./quality-scorer.js";
import { PlanCompiler, type PlanIdentityGenerator } from "./plan-compiler.js";
import { PlanningPromptAssembler } from "./prompt-assembler.js";
import type {
  PlanningModel,
  PlanningModelOperation,
  PlanningModelTokenUsage,
  PlanningUsageLedger,
} from "./model.js";
import {
  isPlanningPreDispatchError,
  resolveChargedTokenTotal,
} from "./model.js";
import { PlanningInferenceBudget } from "./inference-budget.js";
import type { PlanRepository, StoredPlanRecord } from "./plan-repository.js";
import { PLANNING_PROMPT_VERSION } from "./context.js";
import { isPlanningError, PlanningError } from "./errors.js";
import type { PlanningContext } from "./context.js";
import type { AssembledPlanningPrompt } from "./prompt-assembler.js";
import {
  ByteLengthPlanningTokenEstimator,
  DEFAULT_PLANNING_MAX_OUTPUT_TOKENS,
  type PlanningMaxOutputTokensByOperation,
  type PlanningTokenReservationEstimator,
} from "./token-reservation.js";

export interface PlanningResult {
  outcome: "PLANNED";
  runId: string;
  planId: string;
  planHash: string;
  planVersion: typeof INITIAL_PLAN_VERSION;
  status: "READY_FOR_VALIDATION";
  planningContextFingerprint: string;
  runState: "VALIDATING";
}

export interface PlanningServiceDeps {
  readiness: PlanningReadinessService;
  coordinator: PlanningCoordinator;
  runs: RunRepository;
  objectives: ObjectiveRepository;
  controlPlane: ControlPlaneService;
  contexts: VerifiedRepositoryContextStore;
  locks: LockedRepositoryStore;
  evidence: EvidenceRegistry;
  workspace: RepositoryWorkspaceService;
  model: PlanningModel;
  usage: PlanningUsageLedger;
  plans: PlanRepository;
  capabilities: CapabilityRegistry;
  identities: PlanIdentityGenerator;
  clock: ControlPlaneClock;
  contextCompiler?: ContextBudgetController;
  evidenceRefs?: EvidenceReferenceValidator;
  capabilityRefs?: CapabilityReferenceValidator;
  dependencies?: DependencyGraphService;
  resources?: PlanResourceAnalyzer;
  quality?: PlanQualityScorer;
  compiler?: PlanCompiler;
  prompts?: PlanningPromptAssembler;
  inferenceBudget?: PlanningInferenceBudget;
  tokenEstimator?: PlanningTokenReservationEstimator;
  maxOutputTokensByOperation?: PlanningMaxOutputTokensByOperation;
  /** Optional Phase 9 advisory precedent retrieval. Missing → empty precedents. */
  precedentRetriever?: {
    retrieve(query: {
      projectId: string;
      environment?: string;
      actionTypes?: readonly string[];
      capabilityIds?: readonly string[];
      objectiveText?: string;
      currentRepositoryFingerprint?: string;
    }): Promise<{
      precedents: import("../domain/memory/result.js").RetrievedPrecedentContext[];
      retrievalContextFingerprint: string;
    }>;
  };
}

/**
 * Planning application service.
 * Model proposes; deterministic code authorizes structure, hashes, and transitions.
 */
export class PlanningService {
  private readonly readiness: PlanningReadinessService;
  private readonly coordinator: PlanningCoordinator;
  private readonly runs: RunRepository;
  private readonly objectives: ObjectiveRepository;
  private readonly controlPlane: ControlPlaneService;
  private readonly contexts: VerifiedRepositoryContextStore;
  private readonly locks: LockedRepositoryStore;
  private readonly evidence: EvidenceRegistry;
  private readonly workspace: RepositoryWorkspaceService;
  private readonly model: PlanningModel;
  private readonly usage: PlanningUsageLedger;
  private readonly inferenceBudget: PlanningInferenceBudget;
  private readonly plans: PlanRepository;
  private readonly clock: ControlPlaneClock;
  private readonly contextCompiler: ContextBudgetController;
  private readonly evidenceRefs: EvidenceReferenceValidator;
  private readonly capabilityRefs: CapabilityReferenceValidator;
  private readonly dependencies: DependencyGraphService;
  private readonly resources: PlanResourceAnalyzer;
  private readonly quality: PlanQualityScorer;
  private readonly compiler: PlanCompiler;
  private readonly prompts: PlanningPromptAssembler;
  private readonly tokenEstimator: PlanningTokenReservationEstimator;
  private readonly maxOutputTokensByOperation: PlanningMaxOutputTokensByOperation;
  private precedentRetriever: PlanningServiceDeps["precedentRetriever"];

  constructor(deps: PlanningServiceDeps) {
    this.readiness = deps.readiness;
    this.coordinator = deps.coordinator;
    this.runs = deps.runs;
    this.objectives = deps.objectives;
    this.controlPlane = deps.controlPlane;
    this.contexts = deps.contexts;
    this.locks = deps.locks;
    this.evidence = deps.evidence;
    this.workspace = deps.workspace;
    this.model = deps.model;
    this.usage = deps.usage;
    this.inferenceBudget =
      deps.inferenceBudget ?? new PlanningInferenceBudget(deps.usage);
    this.plans = deps.plans;
    this.clock = deps.clock;
    this.contextCompiler = deps.contextCompiler ?? new ContextBudgetController();
    this.evidenceRefs = deps.evidenceRefs ?? new EvidenceReferenceValidator();
    this.capabilityRefs =
      deps.capabilityRefs ??
      new CapabilityReferenceValidator(deps.capabilities);
    this.dependencies = deps.dependencies ?? new DependencyGraphService();
    this.resources = deps.resources ?? new PlanResourceAnalyzer();
    this.quality = deps.quality ?? new PlanQualityScorer();
    this.compiler =
      deps.compiler ?? new PlanCompiler(deps.identities);
    this.prompts = deps.prompts ?? new PlanningPromptAssembler();
    this.tokenEstimator =
      deps.tokenEstimator ?? new ByteLengthPlanningTokenEstimator();
    this.maxOutputTokensByOperation = {
      ...DEFAULT_PLANNING_MAX_OUTPUT_TOKENS,
      ...deps.maxOutputTokensByOperation,
    };
    this.precedentRetriever = deps.precedentRetriever;
  }

  /** Bind Phase 9 retriever after stack construction (optional). */
  bindPrecedentRetriever(
    retriever: NonNullable<PlanningServiceDeps["precedentRetriever"]>,
  ): void {
    this.precedentRetriever = retriever;
  }

  async plan(runId: string): Promise<PlanningResult> {
    const existingPlan = await this.plans.getByRunId(runId);
    if (existingPlan?.status === "READY_FOR_VALIDATION") {
      await this.coordinator.reconcilePlanned(
        runId,
        this.clock.nowIso(),
        existingPlan.planId,
      );
      const run = await this.runs.getById(runId);
      if (run && run.state === "PLANNING") {
        await commitRunTransition(
          this.runs,
          run,
          "VALIDATING",
          this.clock.nowIso(),
        );
      }
      const refreshed = await this.runs.getById(runId);
      return {
        outcome: "PLANNED",
        runId,
        planId: existingPlan.planId,
        planHash: existingPlan.planHash,
        planVersion: INITIAL_PLAN_VERSION,
        status: "READY_FOR_VALIDATION",
        planningContextFingerprint: existingPlan.planningContextFingerprint,
        runState: (refreshed?.state as "VALIDATING") ?? "VALIDATING",
      };
    }

    await this.readiness.assertReady(runId);
    const now = this.clock.nowIso();
    const begin = await this.coordinator.begin(runId, now);
    if (begin.outcome === "ALREADY_PLANNED") {
      const planned = await this.plans.getByRunId(runId);
      if (!planned) {
        throw new PlanningError(
          "PLANNING_RECONCILIATION_FAILED",
          "Planning fence is PLANNED but no plan record exists",
          { runId },
        );
      }
      return {
        outcome: "PLANNED",
        runId,
        planId: planned.planId,
        planHash: planned.planHash,
        planVersion: INITIAL_PLAN_VERSION,
        status: "READY_FOR_VALIDATION",
        planningContextFingerprint: planned.planningContextFingerprint,
        runState: "VALIDATING",
      };
    }

    try {
      const run = await this.runs.getById(runId);
      if (!run) {
        throw new PlanningError(
          "PLANNING_NOT_READY",
          `Run not found: ${runId}`,
        );
      }

      if (run.state === "INGESTING") {
        await commitRunTransition(this.runs, run, "PLANNING", now);
      }

      const objective = await this.objectives.getByRunBinding(runId);
      if (!objective) {
        throw new PlanningError(
          "OBJECTIVE_NOT_FOUND",
          `No objective bound to run ${runId}`,
        );
      }

      const control = await this.controlPlane.resolve(
        run.projectId,
        run.requestedEnvironment,
      );
      const repositoryContext = await this.contexts.getByRunId(runId);
      const liveLock = await this.locks.getByRunId(runId);
      if (!repositoryContext || !liveLock) {
        throw new PlanningError(
          "PLANNING_NOT_READY",
          "Verified repository context/lock missing",
        );
      }

      const evidenceList = await this.evidence.listByRunId(runId);
      const remoteUrl = `https://github.com/${liveLock.repositoryIdentity.owner}/${liveLock.repositoryIdentity.repository}`;
      const contentByEvidenceId = await this.loadEvidenceContent(
        runId,
        liveLock.commitSha,
        remoteUrl,
        evidenceList,
      );
      const compiled = this.contextCompiler.compile({
        run,
        objective,
        control,
        repositoryContext,
        liveLock,
        evidence: evidenceList,
        contentByEvidenceId,
      });

      const gapAnalysis = await this.invokeModel({
        runId,
        planningAttempt: begin.fence.attempt,
        operation: "GAP_ANALYSIS",
        budget: control.resourceBudget,
        assembled: this.prompts.assemble({
          context: compiled,
          mode: "gaps",
        }),
        invoke: async () =>
          this.model.analyzeGaps({
            context: compiled,
            promptVersion: this.prompts.promptVersion,
          }),
      });

      const proposal = await this.invokeModel({
        runId,
        planningAttempt: begin.fence.attempt,
        operation: "PLAN_PROPOSAL",
        budget: control.resourceBudget,
        assembled: this.prompts.assemble({
          context: compiled,
          gapAnalysis,
          mode: "plan",
        }),
        invoke: async () =>
          this.model.proposePlan({
            context: compiled,
            gapAnalysis,
            promptVersion: this.prompts.promptVersion,
          }),
      });

      const evidenceById = new Map(
        evidenceList.map((record) => [record.evidenceId, record]),
      );
      const allRefs = [
        ...proposal.steps.flatMap((step) => step.evidenceRefs),
        ...proposal.gapAnalysis.evidenceRefs,
      ];
      this.evidenceRefs.validate({
        evidenceRefs: allRefs,
        evidenceById,
        runId,
        projectId: run.projectId,
        lockedCommitSha: liveLock.commitSha,
      });

      await this.capabilityRefs.validate({
        actionTypes: proposal.steps.map((step) => step.actionType),
        environment: run.requestedEnvironment,
      });

      const graph = this.dependencies.validate(proposal.steps);
      const resources = this.resources.analyze(
        proposal,
        control.resourceBudget,
      );
      this.quality.score(proposal, compiled);
      const executionPlan = this.compiler.compile({
        proposal,
        context: compiled,
        graph,
        resources,
      });

      const record: StoredPlanRecord = {
        planId: executionPlan.planId,
        runId,
        planVersion: INITIAL_PLAN_VERSION,
        status: "READY_FOR_VALIDATION",
        plan: executionPlan,
        planHash: executionPlan.planHash,
        planningContextFingerprint:
          compiled.contextMetadata.planningContextFingerprint,
        planningPromptVersion: PLANNING_PROMPT_VERSION,
        modelProvider: this.model.provider,
        modelId: this.model.modelId,
        createdAt: this.clock.nowIso(),
      };

      try {
        await this.plans.save(record);
      } catch (error) {
        throw new PlanningError(
          "PLAN_PERSISTENCE_FAILED",
          "Failed to persist READY_FOR_VALIDATION plan",
          { cause: String(error) },
        );
      }

      await this.coordinator.markPlanned(
        runId,
        begin.ownerToken,
        this.clock.nowIso(),
        executionPlan.planId,
      );

      const current = await this.runs.getById(runId);
      if (!current) {
        throw new PlanningError(
          "INVALID_PLANNING_STATE",
          "Run disappeared during planning",
        );
      }
      await commitRunTransition(
        this.runs,
        current,
        "VALIDATING",
        this.clock.nowIso(),
      );

      return {
        outcome: "PLANNED",
        runId,
        planId: executionPlan.planId,
        planHash: executionPlan.planHash,
        planVersion: INITIAL_PLAN_VERSION,
        status: "READY_FOR_VALIDATION",
        planningContextFingerprint:
          compiled.contextMetadata.planningContextFingerprint,
        runState: "VALIDATING",
      };
    } catch (error) {
      const failureCode = isPlanningError(error)
        ? error.code
        : "PLANNING_MODEL_INVALID_OUTPUT";
      await this.coordinator
        .markFailed(runId, begin.ownerToken, {
          failureCode,
          failedAt: this.clock.nowIso(),
          retryable: true,
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async getPlan(runId: string): Promise<StoredPlanRecord | null> {
    return this.plans.getByRunId(runId);
  }

  async getPlanningContextMetadata(
    runId: string,
  ): Promise<{
    planningContextFingerprint: string;
    selectedEvidenceIds: string[];
    excludedEvidenceIds: string[];
    promptVersion: string;
  } | null> {
    const plan = await this.plans.getByRunId(runId);
    if (!plan) {
      return null;
    }
    return {
      planningContextFingerprint: plan.planningContextFingerprint,
      selectedEvidenceIds: [],
      excludedEvidenceIds: [],
      promptVersion: plan.planningPromptVersion,
    };
  }

  /** Compile context for inspection without calling the model. */
  async compileContext(runId: string): Promise<PlanningContext> {
    await this.readiness.assertReady(runId);
    const run = await this.runs.getById(runId);
    if (!run) {
      throw new PlanningError("PLANNING_NOT_READY", `Run not found: ${runId}`);
    }
    const objective = await this.objectives.getByRunBinding(runId);
    if (!objective) {
      throw new PlanningError(
        "OBJECTIVE_NOT_FOUND",
        `No objective bound to run ${runId}`,
      );
    }
    const control = await this.controlPlane.resolve(
      run.projectId,
      run.requestedEnvironment,
    );
    const repositoryContext = await this.contexts.getByRunId(runId);
    const liveLock = await this.locks.getByRunId(runId);
    if (!repositoryContext || !liveLock) {
      throw new PlanningError(
        "PLANNING_NOT_READY",
        "Verified repository context/lock missing",
      );
    }
    const evidenceList = await this.evidence.listByRunId(runId);
    const remoteUrl = `https://github.com/${liveLock.repositoryIdentity.owner}/${liveLock.repositoryIdentity.repository}`;
    const contentByEvidenceId = await this.loadEvidenceContent(
      runId,
      liveLock.commitSha,
      remoteUrl,
      evidenceList,
    );

    let precedents:
      | import("../domain/memory/result.js").RetrievedPrecedentContext[]
      | undefined;
    let retrievalContextFingerprint: string | undefined;
    if (this.precedentRetriever) {
      const retrieved = await this.precedentRetriever.retrieve({
        projectId: run.projectId,
        environment: run.requestedEnvironment,
        objectiveText: objective.requestedOutcome,
        currentRepositoryFingerprint: repositoryContext.repositoryFingerprint,
      });
      precedents = [...retrieved.precedents];
      retrievalContextFingerprint = retrieved.retrievalContextFingerprint;
    }

    return this.contextCompiler.compile({
      run,
      objective,
      control,
      repositoryContext,
      liveLock,
      evidence: evidenceList,
      contentByEvidenceId,
      ...(precedents !== undefined ? { precedents } : {}),
      ...(retrievalContextFingerprint !== undefined
        ? { retrievalContextFingerprint }
        : {}),
    });
  }

  private async invokeModel<T>(input: {
    runId: string;
    planningAttempt: number;
    operation: PlanningModelOperation;
    budget: ResourceBudgetProfile;
    assembled: AssembledPlanningPrompt;
    invoke: () => Promise<{ value: T; usage?: PlanningModelTokenUsage }>;
  }): Promise<T> {
    const maxOutputTokens =
      this.maxOutputTokensByOperation[input.operation];
    const inputTokenEstimate = this.tokenEstimator.estimateInputTokens(
      input.assembled,
    );
    const { reservedTokens } = await this.inferenceBudget.assertCanReserve({
      runId: input.runId,
      budget: input.budget,
      inputTokenEstimate,
      maxOutputTokens,
    });

    const callId = randomUUID();
    const startedAt = this.clock.nowIso();
    await this.usage.reserve({
      callId,
      runId: input.runId,
      planningAttempt: input.planningAttempt,
      operation: input.operation,
      provider: this.model.provider,
      model: this.model.modelId,
      reservedTokens,
      startedAt,
      maximumLlmCalls: input.budget.maximumLlmCalls,
      maximumTotalTokens: input.budget.maximumTotalTokens,
      budgetProfileId: input.budget.budgetProfileId,
    });

    try {
      await this.usage.markDispatched?.(callId);
      assertNotInTransaction("PlanningModel");
      const result = await input.invoke();
      const actualTotal = resolveChargedTokenTotal(result.usage);
      if (actualTotal === undefined) {
        await this.usage.settle(callId, {
          outcome: "SUCCESS",
          completedAt: this.clock.nowIso(),
          charging: "RESERVATION",
        });
      } else {
        const overrun = actualTotal > reservedTokens;
        const settleActual: {
          outcome: "SUCCESS";
          completedAt: string;
          charging: "ACTUAL";
          totalUsage: number;
          inputUsage?: number;
          outputUsage?: number;
          markInvariantViolation?: boolean;
        } = {
          outcome: "SUCCESS",
          completedAt: this.clock.nowIso(),
          charging: "ACTUAL",
          totalUsage: actualTotal,
        };
        if (result.usage?.inputTokens !== undefined) {
          settleActual.inputUsage = result.usage.inputTokens;
        }
        if (result.usage?.outputTokens !== undefined) {
          settleActual.outputUsage = result.usage.outputTokens;
        }
        if (overrun) {
          settleActual.markInvariantViolation = true;
        }
        await this.usage.settle(callId, settleActual);
        if (overrun) {
          throw new PlanningError(
            "PLANNING_MODEL_BUDGET_INVARIANT_VIOLATION",
            "Provider reported token usage exceeding the pre-call reservation",
            {
              reservedTokens,
              actualTotal,
              operation: input.operation,
              runId: input.runId,
            },
          );
        }
      }
      return result.value;
    } catch (error) {
      if (isPlanningError(error) && error.code === "PLANNING_MODEL_BUDGET_INVARIANT_VIOLATION") {
        throw error;
      }
      if (isPlanningPreDispatchError(error)) {
        await this.usage.settle(callId, {
          outcome: "RELEASED",
          completedAt: this.clock.nowIso(),
          charging: "NONE",
          reason: "PRE_DISPATCH_FAILURE",
        });
        throw this.mapModelError(error);
      }

      const status = this.usageStatus(error);
      const providerUsage = extractProviderUsage(error);
      const actualTotal = resolveChargedTokenTotal(providerUsage);
      if (actualTotal === undefined) {
        await this.usage.settle(callId, {
          outcome: status,
          completedAt: this.clock.nowIso(),
          charging: "RESERVATION",
        });
      } else {
        const overrun = actualTotal > reservedTokens;
        const settleActual: {
          outcome: typeof status;
          completedAt: string;
          charging: "ACTUAL";
          totalUsage: number;
          inputUsage?: number;
          outputUsage?: number;
          markInvariantViolation?: boolean;
        } = {
          outcome: status,
          completedAt: this.clock.nowIso(),
          charging: "ACTUAL",
          totalUsage: actualTotal,
        };
        if (providerUsage?.inputTokens !== undefined) {
          settleActual.inputUsage = providerUsage.inputTokens;
        }
        if (providerUsage?.outputTokens !== undefined) {
          settleActual.outputUsage = providerUsage.outputTokens;
        }
        if (overrun) {
          settleActual.markInvariantViolation = true;
        }
        await this.usage.settle(callId, settleActual);
        if (overrun) {
          throw new PlanningError(
            "PLANNING_MODEL_BUDGET_INVARIANT_VIOLATION",
            "Provider reported token usage exceeding the pre-call reservation",
            {
              reservedTokens,
              actualTotal,
              operation: input.operation,
              runId: input.runId,
            },
          );
        }
      }
      throw this.mapModelError(error);
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
            if (!buffer.includes(0)) {
              map.set(record.evidenceId, buffer.toString("utf8"));
            } else {
              map.set(
                record.evidenceId,
                `[binary omitted] size=${buffer.byteLength} hash=${record.contentHash}`,
              );
            }
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

  private mapModelError(error: unknown): PlanningError {
    if (isPlanningError(error)) {
      return error;
    }
    return new PlanningError(
      "PLANNING_MODEL_INVALID_OUTPUT",
      error instanceof Error ? error.message : "Planning model failed",
    );
  }

  private usageStatus(
    error: unknown,
  ): "FAILED" | "TIMEOUT" | "REFUSED" {
    if (isPlanningError(error)) {
      if (error.code === "PLANNING_MODEL_TIMEOUT") {
        return "TIMEOUT";
      }
      if (error.code === "PLANNING_MODEL_REFUSED") {
        return "REFUSED";
      }
    }
    return "FAILED";
  }
}

function extractProviderUsage(
  error: unknown,
): PlanningModelTokenUsage | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "providerUsage" in error &&
    typeof (error as { providerUsage: unknown }).providerUsage === "object" &&
    (error as { providerUsage: unknown }).providerUsage !== null
  ) {
    return (error as { providerUsage: PlanningModelTokenUsage }).providerUsage;
  }
  return undefined;
}
