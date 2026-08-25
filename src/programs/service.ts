import { createHash, randomUUID } from "node:crypto";
import type { ObjectiveAdmissionService } from "../admission/service.js";
import type { AdmissionRequest } from "../admission/request.js";
import type { ControlPlaneService } from "../control-plane/service.js";
import { capabilitySetFingerprint } from "../execution/capability-fingerprint.js";
import {
  issueDecisionNonce,
  type DecisionNonceGenerator,
} from "../authorization/decision-nonce.js";
import { hashDecisionNonce } from "../authorization/decision-card-hasher.js";
import type { RunRepository } from "../admission/run-repository.js";
import type { CompletionRecordRepository } from "../verification/completion-repository.js";
import type { PortfolioSchedulerService } from "../scheduling/service.js";
import {
  budgetAllocationFingerprint,
  availableToReserve,
  canReserve,
  addBudget,
  emptyBudgetEstimate,
  reservationIdFor,
  type ProgramBudgetLedger,
} from "./budget.js";
import { compileProgramPlan } from "./compiler.js";
import type { ProgramDecompositionModel } from "./decomposition-model.js";
import {
  delegationEnvelopeHash,
  parseDelegationEnvelope,
  type DelegationEnvelope,
} from "./delegation-envelope.js";
import { ProgramError } from "./errors.js";
import {
  childObjectiveIdentity,
  programContentFingerprint,
  programIdempotencyKey,
} from "./identity.js";
import {
  lineageIdFor,
  type ProgramCompletionRecord,
  type ProgramLineageRecord,
  type ProgramMaterializationApproval,
} from "./lineage.js";
import {
  budgetConfigurationFingerprint,
  projectConfigurationFingerprint,
  repositoryAllowlistFingerprint,
} from "./authority.js";
import { parseProgram, type Program, type ProgramRootIntent } from "./program.js";
import {
  INITIAL_PROGRAM_PLAN_VERSION,
  type ProgramPlan,
} from "./program-plan.js";
import { INITIAL_PROGRAM_VERSION } from "./program.js";
import type {
  ProgramBudgetLedgerRepository,
  ProgramBudgetReservationRepository,
  ProgramCompletionRepository,
  ProgramLineageRepository,
  ProgramMaterializationApprovalRepository,
  ProgramPlanRepository,
  ProgramRepository,
} from "./repositories.js";
import { assertValidProgramPlan, validateProgramPlan } from "./validator.js";
import {
  canTransitionProgram,
  type ProgramState,
} from "./program-state.js";
import { proveRootCriterion } from "./criterion-proof.js";
import {
  withOptionalTransaction,
  type TransactionManager,
} from "../durability/transaction.js";
import type { OutcomeVerificationRepository } from "../verification/outcome-repository.js";

export type ProgramCompletionFailpointStage =
  | "AFTER_PROGRAM_COMPLETION_RECORD"
  | "AFTER_PROGRAM_TRANSITION";

export interface ProgramCompletionFailpoint {
  hit(stage: ProgramCompletionFailpointStage): Promise<void>;
}

/** Test/recovery inject: throw after N newly admitted children in one materializeNext. */
export interface ProgramMaterializationFailpoint {
  hit(newlyAdmittedCount: number): Promise<void>;
}

export interface ProgramAdmissionRequest {
  programId?: string;
  programVersion?: number;
  projectId: string;
  requesterId: string;
  requestedEnvironment: string;
  rootIntent: ProgramRootIntent;
  delegationEnvelope: DelegationEnvelope;
  submittedAt: string;
  correlationId?: string;
  traceId?: string;
}

export type ProgramAdmissionOutcome =
  | { outcome: "ADMITTED"; program: Program }
  | { outcome: "DUPLICATE"; program: Program }
  | { outcome: "VERSION_CONFLICT"; existing: Program; message: string };

export interface ProgramServiceDeps {
  nowIso: () => string;
  programs: ProgramRepository;
  plans: ProgramPlanRepository;
  budgets: ProgramBudgetLedgerRepository;
  reservations: ProgramBudgetReservationRepository;
  lineage: ProgramLineageRepository;
  materializationApprovals: ProgramMaterializationApprovalRepository;
  completions: ProgramCompletionRepository;
  controlPlane: ControlPlaneService;
  decompositionModel: ProgramDecompositionModel;
  nonceGenerator: DecisionNonceGenerator;
  /** Plaintext nonces for delivery (tests / in-process delivery). */
  materializationNonceStore?: {
    put(approvalId: string, plaintext: string): Promise<void>;
    take(approvalId: string): Promise<string | null>;
  };
  /** Distinct from Phase 6 execution approver. */
  isProgramMaterializer?: (
    principalId: string,
    projectId: string,
  ) => Promise<boolean>;
  objectiveAdmission?: ObjectiveAdmissionService;
  runs?: RunRepository;
  runCompletions?: CompletionRecordRepository;
  outcomeVerifications?: OutcomeVerificationRepository;
  scheduler?: PortfolioSchedulerService;
  transactions?: TransactionManager;
  completionFailpoint?: ProgramCompletionFailpoint;
  materializationFailpoint?: ProgramMaterializationFailpoint;
  /**
   * Live control-plane repository identities currently authorized for a project.
   * When the Program envelope names repositories, each must remain ⊆ this set
   * or materialization fails closed (stale approval cannot preserve revoked scope).
   */
  authorizedRepositoryIdentities?: (
    projectId: string,
  ) => Promise<readonly string[]>;
}

export class ProgramOrchestrationService {
  constructor(private readonly deps: ProgramServiceDeps) {}

  async admit(
    request: ProgramAdmissionRequest,
  ): Promise<ProgramAdmissionOutcome> {
    const envelope = parseDelegationEnvelope(request.delegationEnvelope);
    if (!envelope.allowedProjectIds.includes(request.projectId)) {
      throw new ProgramError(
        "PROJECT_OUTSIDE_ENVELOPE",
        "Program projectId must be listed in delegation envelope",
      );
    }
    const context = await this.deps.controlPlane.resolve(
      request.projectId,
      request.requestedEnvironment,
    );
    const programId = request.programId ?? `prog_${randomUUID()}`;
    const programVersion = request.programVersion ?? INITIAL_PROGRAM_VERSION;
    const idempotencyKey = programIdempotencyKey({
      projectId: request.projectId,
      programId,
      programVersion,
      requestedEnvironment: request.requestedEnvironment,
    });
    const envelopeHash = delegationEnvelopeHash(envelope);
    const contentFingerprint = programContentFingerprint({
      rootIntent: request.rootIntent,
      requesterId: request.requesterId,
      delegationEnvelopeHash: envelopeHash,
    });

    const existing = await this.deps.programs.getByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.contentFingerprint !== contentFingerprint) {
        return {
          outcome: "VERSION_CONFLICT",
          existing,
          message: "Same program identity with different semantic content",
        };
      }
      return { outcome: "DUPLICATE", program: existing };
    }

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
    const now = request.submittedAt;
    const program = parseProgram({
      programId,
      programVersion,
      projectId: request.projectId,
      requesterId: request.requesterId,
      requestedEnvironment: request.requestedEnvironment,
      rootIntent: request.rootIntent,
      status: "ADMITTED",
      delegationEnvelope: envelope,
      authorityFreeze: {
        policyBundleId: context.activePolicyBundle.policyBundleId,
        policyBundleHash: context.activePolicyBundle.policyHash,
        capabilitySetFingerprint: capabilitySetFingerprint(caps),
        projectConfigurationFingerprint: projectConfigurationFingerprint({
          projectId: request.projectId,
          activePolicyBundleId: context.project.activePolicyBundleId,
          budgetProfileId: context.project.resourceBudgetProfileId,
          allowedEnvironments: context.project.allowedEnvironments,
          executionMode: context.project.executionMode,
        }),
        budgetProfileId: context.resourceBudget.budgetProfileId,
        budgetConfigurationFingerprint: budgetConfigurationFingerprint(
          context.resourceBudget.budgetProfileId,
          envelope.maximumProgramBudget,
        ),
        repositoryAllowlistFingerprint: repositoryAllowlistFingerprint(
          envelope.allowedRepositoryIdentities,
        ),
        delegationEnvelopeHash: envelopeHash,
        frozenAt: now,
      },
      decompositionRevisionCount: 0,
      maximumDecompositionRevisions: 2,
      paused: false,
      createdAt: now,
      updatedAt: now,
      recordRevision: 1,
      correlationId: request.correlationId ?? `corr_${programId}`,
      traceId: request.traceId ?? `trace_${programId}`,
      idempotencyKey,
      contentFingerprint,
    });

    const created = await this.deps.programs.create(program);
    await this.deps.budgets.create({
      programId: created.programId,
      programVersion: created.programVersion,
      ceiling: envelope.maximumProgramBudget,
      reserved: emptyBudgetEstimate(),
      settled: emptyBudgetEstimate(),
      released: emptyBudgetEstimate(),
      recordRevision: 1,
      updatedAt: now,
    });
    return { outcome: "ADMITTED", program: created };
  }

  async decompose(programId: string): Promise<{
    program: Program;
    plan: ProgramPlan | null;
    findings?: unknown;
  }> {
    const program = await this.requireProgram(programId);
    if (program.paused) {
      throw new ProgramError("PROGRAM_PAUSED", "Program is paused");
    }
    let current = program;
    if (current.status === "ADMITTED" || current.status === "VALIDATING") {
      current = await this.transition(current, "DECOMPOSING");
    } else if (current.status !== "DECOMPOSING") {
      throw new ProgramError(
        "INVALID_PROGRAM_TRANSITION",
        `Cannot decompose from ${current.status}`,
      );
    }

    const revisionAttempt = current.decompositionRevisionCount;
    if (revisionAttempt > current.maximumDecompositionRevisions) {
      return {
        program: await this.transition(current, "BLOCKED", {
          failureReasonCode: "DECOMPOSITION_BUDGET_EXCEEDED",
        }),
        plan: null,
      };
    }

    const proposal = await this.deps.decompositionModel.decompose({
      program: current,
      revisionAttempt,
    });
    const now = this.deps.nowIso();
    const planVersion =
      (current.programPlanVersion ?? INITIAL_PROGRAM_PLAN_VERSION - 1) + 1;
    const compiled = compileProgramPlan({
      program: current,
      proposal,
      programPlanVersion: Math.max(planVersion, INITIAL_PROGRAM_PLAN_VERSION),
      revisionAttempt,
      createdAt: now,
    });
    const validation = validateProgramPlan(current, compiled);
    if (!validation.valid) {
      if (revisionAttempt >= current.maximumDecompositionRevisions) {
        const blocked = await this.deps.programs.transition(
          current.programId,
          current.status,
          current.recordRevision,
          "BLOCKED",
          now,
          {
            decompositionRevisionCount: revisionAttempt + 1,
            failureReasonCode: "PROGRAM_PLAN_INVALID",
          },
        );
        return { program: blocked, plan: null, findings: validation.findings };
      }
      const retrying = await this.deps.programs.save(
        {
          ...current,
          decompositionRevisionCount: revisionAttempt + 1,
          updatedAt: now,
        },
        current.recordRevision,
      );
      return { program: retrying, plan: null, findings: validation.findings };
    }

    const savedPlan = await this.deps.plans.save(compiled);
    const decomposed = await this.deps.programs.transition(
      current.programId,
      current.status,
      current.recordRevision,
      "DECOMPOSED",
      now,
      {
        programPlanVersion: savedPlan.programPlanVersion,
        programPlanHash: savedPlan.programPlanHash,
        decompositionRevisionCount: revisionAttempt + 1,
      },
    );
    return { program: decomposed, plan: savedPlan };
  }

  async validate(programId: string): Promise<{
    program: Program;
    valid: boolean;
  }> {
    let program = await this.requireProgram(programId);
    if (program.status === "DECOMPOSED") {
      program = await this.transition(program, "VALIDATING");
    }
    const plan = await this.requireLatestPlan(program);
    const result = validateProgramPlan(program, plan);
    if (!result.valid) {
      const blocked = await this.transition(program, "BLOCKED", {
        failureReasonCode: "PROGRAM_PLAN_INVALID",
      });
      return { program: blocked, valid: false };
    }
    await this.recheckAuthorityFreeze(program);
    const awaiting = await this.transition(
      program,
      "AWAITING_MATERIALIZATION_APPROVAL",
    );
    return { program: awaiting, valid: true };
  }

  async routeMaterializationApproval(programId: string): Promise<{
    approval: ProgramMaterializationApproval;
    decisionNonce: string;
  }> {
    const program = await this.requireProgram(programId);
    if (program.status !== "AWAITING_MATERIALIZATION_APPROVAL") {
      throw new ProgramError(
        "INVALID_PROGRAM_TRANSITION",
        `Materialization routing requires AWAITING_MATERIALIZATION_APPROVAL`,
      );
    }
    const plan = await this.requireLatestPlan(program);
    const existing = await this.deps.materializationApprovals.getPendingByProgram(
      programId,
    );
    if (existing) {
      const stored = await this.deps.materializationNonceStore?.take(
        existing.approvalId,
      );
      if (stored) {
        await this.deps.materializationNonceStore?.put(
          existing.approvalId,
          stored,
        );
        return { approval: existing, decisionNonce: stored };
      }
    }

    const allocations = plan.nodes.map((n) => ({
      nodeId: n.nodeId,
      amount: n.requestedBudget,
    }));
    const now = this.deps.nowIso();
    const expiresAt = new Date(
      Date.parse(now) + 24 * 60 * 60 * 1000,
    ).toISOString();
    const subjectHash = createHash("sha256")
      .update(
        JSON.stringify({
          budgetAllocationFingerprint: budgetAllocationFingerprint(allocations),
          capabilitySetFingerprint:
            program.authorityFreeze.capabilitySetFingerprint,
          delegationEnvelopeHash:
            program.authorityFreeze.delegationEnvelopeHash,
          environmentScope: program.requestedEnvironment,
          expiresAt,
          policyBundleHash: program.authorityFreeze.policyBundleHash,
          programId: program.programId,
          programPlanHash: plan.programPlanHash,
          programPlanVersion: plan.programPlanVersion,
          programVersion: program.programVersion,
          repositoryAllowlistFingerprint:
            program.authorityFreeze.repositoryAllowlistFingerprint,
        }),
        "utf8",
      )
      .digest("hex");
    const issued = issueDecisionNonce(this.deps.nonceGenerator);
    const approval: ProgramMaterializationApproval = {
      approvalId: `pma_${program.programId}_${plan.programPlanVersion}`,
      programId: program.programId,
      programVersion: program.programVersion,
      programPlanVersion: plan.programPlanVersion,
      programPlanHash: plan.programPlanHash,
      delegationEnvelopeHash: program.authorityFreeze.delegationEnvelopeHash,
      policyBundleHash: program.authorityFreeze.policyBundleHash,
      capabilitySetFingerprint: program.authorityFreeze.capabilitySetFingerprint,
      budgetAllocationFingerprint: budgetAllocationFingerprint(allocations),
      subjectHash,
      decisionNonceHash: issued.nonceHash,
      status: "PENDING",
      expiresAt,
      createdAt: now,
      recordRevision: 1,
    };
    const saved = await this.deps.materializationApprovals.save(approval);
    await this.deps.materializationNonceStore?.put(
      saved.approvalId,
      issued.plaintext,
    );
    return { approval: saved, decisionNonce: issued.plaintext };
  }

  async decideMaterialization(input: {
    approvalId: string;
    approverId: string;
    decision: "APPROVE" | "REJECT";
    decisionNonce: string;
    submittedAt: string;
  }): Promise<ProgramMaterializationApproval> {
    const approval = await this.deps.materializationApprovals.getById(
      input.approvalId,
    );
    if (!approval || approval.status !== "PENDING") {
      throw new ProgramError(
        "MATERIALIZATION_APPROVAL_INVALID",
        "No pending materialization approval",
      );
    }
    if (Date.parse(input.submittedAt) > Date.parse(approval.expiresAt)) {
      const expired = await this.deps.materializationApprovals.save({
        ...approval,
        status: "EXPIRED",
        recordRevision: approval.recordRevision + 1,
      });
      throw new ProgramError(
        "MATERIALIZATION_APPROVAL_EXPIRED",
        "Materialization approval expired",
        { approvalId: expired.approvalId },
      );
    }
    if (hashDecisionNonce(input.decisionNonce) !== approval.decisionNonceHash) {
      throw new ProgramError(
        "MATERIALIZATION_APPROVAL_INVALID",
        "Decision nonce mismatch",
      );
    }
    const program = await this.requireProgram(approval.programId);
    if (!this.deps.isProgramMaterializer) {
      throw new ProgramError(
        "MATERIALIZATION_APPROVAL_INVALID",
        "PROGRAM_MATERIALIZER authority check not configured",
      );
    }
    const allowed = await this.deps.isProgramMaterializer(
      input.approverId,
      program.projectId,
    );
    if (!allowed) {
      throw new ProgramError(
        "MATERIALIZATION_APPROVAL_INVALID",
        "Principal lacks PROGRAM_MATERIALIZER authority",
      );
    }
    await this.recheckAuthorityFreeze(program);
    const decided = await this.deps.materializationApprovals.save({
      ...approval,
      status: input.decision === "APPROVE" ? "APPROVED" : "REJECTED",
      approverId: input.approverId,
      decidedAt: input.submittedAt,
      recordRevision: approval.recordRevision + 1,
    });
    if (input.decision === "APPROVE") {
      if (program.status === "AWAITING_MATERIALIZATION_APPROVAL") {
        await this.transition(program, "MATERIALIZING");
      }
    }
    return decided;
  }

  /**
   * Idempotent per-node child materialization via Phase 2 admission.
   * PROGRAM approval ≠ child execution approval.
   */
  async materializeNext(programId: string): Promise<{
    program: Program;
    materialized: ProgramLineageRecord[];
  }> {
    let program = await this.requireProgram(programId);
    if (program.paused) {
      throw new ProgramError("PROGRAM_PAUSED", "Program is paused");
    }
    if (program.status === "AWAITING_MATERIALIZATION_APPROVAL") {
      // Barrier: no children without approval.
      throw new ProgramError(
        "MATERIALIZATION_APPROVAL_REQUIRED",
        "Human materialization approval required",
      );
    }
    if (program.status !== "MATERIALIZING" && program.status !== "ACTIVE") {
      throw new ProgramError(
        "INVALID_PROGRAM_TRANSITION",
        `Cannot materialize from ${program.status}`,
      );
    }
    const approval = [
      ...(await this.deps.materializationApprovals.getPendingByProgram(
        programId,
      )
        ? []
        : []),
    ];
    void approval;
    const approved = await this.findApprovedMaterialization(program);
    if (!approved) {
      throw new ProgramError(
        "MATERIALIZATION_APPROVAL_REQUIRED",
        "No approved materialization for current plan",
      );
    }
    const plan = await this.requireLatestPlan(program);
    if (
      plan.programPlanHash !== approved.programPlanHash ||
      plan.programPlanVersion !== approved.programPlanVersion
    ) {
      throw new ProgramError(
        "MATERIALIZATION_APPROVAL_INVALID",
        "Approval does not bind current program plan",
      );
    }
    await this.recheckAuthorityFreeze(program, plan);
    if (!this.deps.objectiveAdmission) {
      throw new ProgramError(
        "CHILD_ADMISSION_FAILED",
        "Objective admission service not configured",
      );
    }

    const materialized: ProgramLineageRecord[] = [];
    let newlyAdmitted = 0;
    for (const node of plan.nodes) {
      const lineageId = lineageIdFor({
        programId: program.programId,
        programPlanVersion: plan.programPlanVersion,
        nodeId: node.nodeId,
      });
      const existing = await this.deps.lineage.getById(lineageId);
      if (
        existing &&
        (existing.materializationStatus === "ADMITTED" ||
          existing.materializationStatus === "DUPLICATE")
      ) {
        materialized.push(existing);
        continue;
      }

      await this.reserveNodeBudget(program, plan, node.nodeId, node.requestedBudget);

      const identity = childObjectiveIdentity({
        programId: program.programId,
        programPlanVersion: plan.programPlanVersion,
        nodeId: node.nodeId,
      });
      const now = this.deps.nowIso();
      const admissionRequest: AdmissionRequest = {
        projectId: node.requestedProjectId,
        objectiveId: identity.objectiveId,
        objectiveVersion: identity.objectiveVersion,
        requestedOutcome: node.requestedOutcome,
        acceptanceCriteria: [...node.acceptanceCriteria],
        nonGoals: [...node.nonGoals],
        constraints: [...node.constraints],
        priority: node.priority,
        requesterId: program.requesterId,
        requestedEnvironment: node.requestedEnvironment,
        submittedAt: now,
      };
      const result = await this.deps.objectiveAdmission.admit(admissionRequest);
      const status =
        result.outcome === "ADMITTED"
          ? "ADMITTED"
          : result.outcome === "ACTIVE_DUPLICATE" ||
              result.outcome === "COMPLETED_DUPLICATE"
            ? "DUPLICATE"
            : "FAILED";
      const runId =
        result.outcome === "ADMITTED" ||
        result.outcome === "ACTIVE_DUPLICATE" ||
        result.outcome === "COMPLETED_DUPLICATE"
          ? result.runId
          : undefined;
      const failureReasonCode =
        status === "FAILED"
          ? result.outcome === "REJECTED" || result.outcome === "CONFLICT"
            ? String(result.reasonCode)
            : String(result.outcome)
          : undefined;
      const record: ProgramLineageRecord = {
        lineageId,
        programId: program.programId,
        programVersion: program.programVersion,
        programPlanVersion: plan.programPlanVersion,
        programPlanHash: plan.programPlanHash,
        nodeId: node.nodeId,
        childObjectiveId: identity.objectiveId,
        childObjectiveVersion: identity.objectiveVersion,
        childRunId: runId,
        materializationStatus: status,
        ...(failureReasonCode !== undefined ? { failureReasonCode } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        recordRevision: (existing?.recordRevision ?? 0) + 1,
      };
      const saved = await this.deps.lineage.save(record);
      materialized.push(saved);
      if (status === "ADMITTED" || status === "DUPLICATE") {
        newlyAdmitted += 1;
        await this.deps.materializationFailpoint?.hit(newlyAdmitted);
      }
    }

    await this.compileDependencies(program, plan, materialized);

    const allDone = materialized.every(
      (m) =>
        m.materializationStatus === "ADMITTED" ||
        m.materializationStatus === "DUPLICATE",
    );
    program = await this.requireProgram(programId);
    if (allDone && program.status === "MATERIALIZING") {
      program = await this.transition(program, "ACTIVE");
    }
    return { program, materialized };
  }

  async reconcile(programId: string): Promise<{
    program: Program;
    requiredComplete: number;
    requiredTotal: number;
    optionalFailed: number;
    childSummaries: readonly {
      nodeId: string;
      requirement: string;
      runId?: string;
      runState?: string;
      hasCompletionRecord: boolean;
    }[];
  }> {
    const program = await this.requireProgram(programId);
    const plan = await this.requireLatestPlan(program);
    const lineage = await this.deps.lineage.listByPlan(
      program.programId,
      plan.programPlanVersion,
    );
    const childSummaries = [];
    let requiredComplete = 0;
    let optionalFailed = 0;
    const requiredTotal = plan.nodes.filter(
      (n) => n.requirement === "REQUIRED",
    ).length;

    for (const node of plan.nodes) {
      const link = lineage.find((l) => l.nodeId === node.nodeId);
      const runId = link?.childRunId;
      let runState: string | undefined;
      let hasCompletionRecord = false;
      if (runId && this.deps.runs) {
        const run = await this.deps.runs.getById(runId);
        runState = run?.state;
        if (run?.state === "COMPLETED" && this.deps.runCompletions) {
          const completion = await this.deps.runCompletions.getByRun(runId);
          hasCompletionRecord = completion !== null;
        }
      }
      if (
        node.requirement === "REQUIRED" &&
        runState === "COMPLETED" &&
        hasCompletionRecord
      ) {
        requiredComplete += 1;
      }
      if (
        node.requirement === "OPTIONAL" &&
        runState &&
        ["FAILED", "CONTAINED", "CANCELLED", "BLOCKED"].includes(runState)
      ) {
        optionalFailed += 1;
      }
      if (
        node.requirement === "REQUIRED" &&
        runState &&
        ["FAILED", "CONTAINED", "CANCELLED"].includes(runState)
      ) {
        // required failure tracked via incomplete requiredComplete
      }
      childSummaries.push({
        nodeId: node.nodeId,
        requirement: node.requirement,
        ...(runId ? { runId } : {}),
        ...(runState ? { runState } : {}),
        hasCompletionRecord,
      });
    }

    return {
      program,
      requiredComplete,
      requiredTotal,
      optionalFailed,
      childSummaries,
    };
  }

  async verify(programId: string): Promise<{
    program: Program;
    outcome: string;
    completion?: ProgramCompletionRecord;
  }> {
    let program = await this.requireProgram(programId);
    const existingCompletion =
      await this.deps.completions.getByProgram(programId);
    if (existingCompletion && program.status === "COMPLETED") {
      return {
        program,
        outcome: "VERIFIED_SUCCESS",
        completion: existingCompletion,
      };
    }
    if (program.status === "ACTIVE") {
      try {
        program = await this.transition(program, "VERIFYING");
      } catch {
        program = await this.requireProgram(programId);
        if (program.status === "COMPLETED") {
          const done = await this.deps.completions.getByProgram(programId);
          if (done) {
            return {
              program,
              outcome: "VERIFIED_SUCCESS",
              completion: done,
            };
          }
        }
        if (program.status !== "VERIFYING") {
          throw new ProgramError(
            "INVALID_PROGRAM_TRANSITION",
            `Cannot verify from ${program.status}`,
          );
        }
      }
    }
    const plan = await this.requireLatestPlan(program);
    const lineage = await this.deps.lineage.listByPlan(
      program.programId,
      plan.programPlanVersion,
    );
    const runsById = new Map<string, Awaited<ReturnType<NonNullable<ProgramServiceDeps["runs"]>["getById"]>>>();
    const completionsByRunId = new Map<
      string,
      Awaited<ReturnType<NonNullable<ProgramServiceDeps["runCompletions"]>["getByRun"]>>
    >();
    const outcomesById = new Map<
      string,
      Awaited<
        ReturnType<
          NonNullable<ProgramServiceDeps["outcomeVerifications"]>["getById"]
        >
      >
    >();
    for (const link of lineage) {
      if (!link.childRunId) {
        continue;
      }
      if (this.deps.runs) {
        runsById.set(
          link.childRunId,
          await this.deps.runs.getById(link.childRunId),
        );
      }
      if (this.deps.runCompletions) {
        const completion = await this.deps.runCompletions.getByRun(
          link.childRunId,
        );
        completionsByRunId.set(link.childRunId, completion);
        if (completion && this.deps.outcomeVerifications) {
          outcomesById.set(
            completion.outcomeVerificationId,
            await this.deps.outcomeVerifications.getById(
              completion.outcomeVerificationId,
            ),
          );
        }
      }
    }

    const criterionResults: ProgramCompletionRecord["criterionResults"] = [];
    for (let i = 0; i < program.rootIntent.acceptanceCriteria.length; i++) {
      const proof = proveRootCriterion({
        program,
        plan,
        rootCriterionIndex: i,
        lineage,
        runsById,
        completionsByRunId,
        outcomesById,
      });
      if (!proof.satisfied) {
        if (proof.outcome === "PROGRAM_FAILED") {
          const failed = await this.transition(program, "ESCALATED", {
            failureReasonCode: proof.reasonCode,
          });
          return { program: failed, outcome: "PROGRAM_FAILED" };
        }
        const escalated = await this.transition(program, "ESCALATED", {
          failureReasonCode: proof.reasonCode,
        });
        return { program: escalated, outcome: "INCONCLUSIVE" };
      }
      criterionResults.push({
        rootCriterionIndex: i,
        satisfied: true,
        evidenceRefs: proof.evidenceRefs,
      });
    }

    const now = this.deps.nowIso();
    const completion: ProgramCompletionRecord = {
      programCompletionRecordId: `pcr_${program.programId}`,
      programId: program.programId,
      programVersion: program.programVersion,
      programPlanVersion: plan.programPlanVersion,
      programPlanHash: plan.programPlanHash,
      outcome: "VERIFIED_SUCCESS",
      criterionResults,
      createdAt: now,
    };
    const completed = await withOptionalTransaction(
      this.deps.transactions,
      async () => {
        const raced = await this.deps.completions.getByProgram(programId);
        if (raced) {
          const live = await this.requireProgram(programId);
          if (live.status === "COMPLETED") {
            return live;
          }
        }
        await this.deps.completions.save(completion);
        await this.deps.completionFailpoint?.hit(
          "AFTER_PROGRAM_COMPLETION_RECORD",
        );
        const live = await this.requireProgram(programId);
        if (live.status === "COMPLETED") {
          return live;
        }
        const next = await this.transition(live, "COMPLETED");
        await this.deps.completionFailpoint?.hit("AFTER_PROGRAM_TRANSITION");
        return next;
      },
    );
    const saved =
      (await this.deps.completions.getByProgram(programId)) ?? completion;
    return { program: completed, outcome: "VERIFIED_SUCCESS", completion: saved };
  }

  async pause(programId: string): Promise<Program> {
    const program = await this.requireProgram(programId);
    if (program.status === "ACTIVE") {
      return this.deps.programs.transition(
        program.programId,
        "ACTIVE",
        program.recordRevision,
        "PAUSED",
        this.deps.nowIso(),
        { paused: true },
      );
    }
    return this.deps.programs.save(
      { ...program, paused: true, updatedAt: this.deps.nowIso() },
      program.recordRevision,
    );
  }

  async resume(programId: string): Promise<Program> {
    const program = await this.requireProgram(programId);
    if (program.status === "PAUSED") {
      return this.deps.programs.transition(
        program.programId,
        "PAUSED",
        program.recordRevision,
        "ACTIVE",
        this.deps.nowIso(),
        { paused: false },
      );
    }
    return this.deps.programs.save(
      { ...program, paused: false, updatedAt: this.deps.nowIso() },
      program.recordRevision,
    );
  }

  async explainChild(input: {
    programId: string;
    nodeId: string;
  }): Promise<Record<string, unknown>> {
    const program = await this.requireProgram(input.programId);
    const plan = await this.requireLatestPlan(program);
    const node = plan.nodes.find((n) => n.nodeId === input.nodeId);
    if (!node) {
      throw new ProgramError("PROGRAM_NOT_FOUND", "Node not found in plan");
    }
    const lineage = await this.deps.lineage.getById(
      lineageIdFor({
        programId: program.programId,
        programPlanVersion: plan.programPlanVersion,
        nodeId: node.nodeId,
      }),
    );
    const approval = await this.findApprovedMaterialization(program);
    return {
      programId: program.programId,
      planVersion: plan.programPlanVersion,
      nodeId: node.nodeId,
      title: node.title,
      rootCriteria: node.criterionBindings.map((b) => ({
        index: b.rootCriterionIndex,
        text: program.rootIntent.acceptanceCriteria[b.rootCriterionIndex],
        contributionKind: b.contributionKind,
      })),
      delegatedBudget: node.requestedBudget,
      delegatedAuthority: {
        projectId: node.requestedProjectId,
        environment: node.requestedEnvironment,
        capabilityIds: node.requestedCapabilityIds,
        repositoryIdentities: node.requestedRepositoryIdentities,
      },
      dependencies: plan.edges
        .filter((e) => e.toNodeId === node.nodeId)
        .map((e) => e.fromNodeId),
      materializationAuthorizationId: approval?.approvalId ?? null,
      childObjectiveId: lineage?.childObjectiveId ?? null,
      childRunId: lineage?.childRunId ?? null,
    };
  }

  private async findApprovedMaterialization(
    program: Program,
  ): Promise<ProgramMaterializationApproval | null> {
    // Scan via pending helper is insufficient; load by deterministic id.
    const plan = await this.deps.plans.getLatest(program.programId);
    if (!plan) {
      return null;
    }
    const approvalId = `pma_${program.programId}_${plan.programPlanVersion}`;
    const approval = await this.deps.materializationApprovals.getById(approvalId);
    return approval?.status === "APPROVED" ? approval : null;
  }

  private async reserveNodeBudget(
    program: Program,
    plan: ProgramPlan,
    nodeId: string,
    amount: ProgramBudgetLedger["ceiling"],
  ): Promise<void> {
    const reservationId = reservationIdFor({
      programId: program.programId,
      programPlanVersion: plan.programPlanVersion,
      nodeId,
    });
    const existing = await this.deps.reservations.getById(reservationId);
    if (existing && existing.status !== "RELEASED") {
      return;
    }
    const ledger = await this.deps.budgets.get(program.programId);
    if (!ledger) {
      throw new ProgramError(
        "PROGRAM_BUDGET_OVER_ALLOCATION",
        "Budget ledger missing",
      );
    }
    const available = availableToReserve(ledger);
    if (!canReserve(available, amount)) {
      throw new ProgramError(
        "PROGRAM_BUDGET_OVER_ALLOCATION",
        "Insufficient program budget remaining",
        { nodeId, available, amount },
      );
    }
    const now = this.deps.nowIso();
    await this.deps.budgets.saveCas(
      {
        ...ledger,
        reserved: addBudget(ledger.reserved, amount),
        updatedAt: now,
      },
      ledger.recordRevision,
    );
    await this.deps.reservations.save({
      reservationId,
      programId: program.programId,
      programPlanVersion: plan.programPlanVersion,
      nodeId,
      amount,
      status: "RESERVED",
      createdAt: now,
      updatedAt: now,
      recordRevision: 1,
    });
  }

  private async compileDependencies(
    program: Program,
    plan: ProgramPlan,
    lineage: readonly ProgramLineageRecord[],
  ): Promise<void> {
    if (!this.deps.scheduler) {
      return;
    }
    const runByNode = new Map(
      lineage
        .filter((l) => l.childRunId)
        .map((l) => [l.nodeId, l.childRunId!] as const),
    );
    for (const edge of plan.edges) {
      const prerequisiteRunId = runByNode.get(edge.fromNodeId);
      const dependentRunId = runByNode.get(edge.toNodeId);
      if (!prerequisiteRunId || !dependentRunId) {
        continue;
      }
      try {
        await this.deps.scheduler.registerDependency({
          projectId: program.projectId,
          dependentRunId,
          prerequisiteRunId,
          requiredMilestone: edge.requiredMilestone,
        });
      } catch {
        // Idempotent / cycle already registered — fail closed only on hard errors later.
      }
    }
  }

  private async recheckAuthorityFreeze(
    program: Program,
    plan?: ProgramPlan,
  ): Promise<void> {
    const context = await this.deps.controlPlane.resolve(
      program.projectId,
      program.requestedEnvironment,
    );
    if (
      context.activePolicyBundle.policyHash !==
      program.authorityFreeze.policyBundleHash
    ) {
      throw new ProgramError(
        "AUTHORITY_DRIFT",
        "Policy bundle hash drifted since program admission",
      );
    }
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
    if (
      capabilitySetFingerprint(caps) !==
      program.authorityFreeze.capabilitySetFingerprint
    ) {
      throw new ProgramError(
        "AUTHORITY_DRIFT",
        "Capability set fingerprint drifted since program admission",
      );
    }
    const projectFp = projectConfigurationFingerprint({
      projectId: program.projectId,
      activePolicyBundleId: context.project.activePolicyBundleId,
      budgetProfileId: context.project.resourceBudgetProfileId,
      allowedEnvironments: context.project.allowedEnvironments,
      executionMode: context.project.executionMode,
    });
    if (
      projectFp !== program.authorityFreeze.projectConfigurationFingerprint
    ) {
      throw new ProgramError(
        "AUTHORITY_DRIFT",
        "Project configuration fingerprint drifted since program admission",
      );
    }
    // Environments are canonical in projectConfigurationFingerprint; still
    // assert usable child scope explicitly when a plan is in hand.
    const environmentsToCheck = new Set<string>([
      program.requestedEnvironment,
      ...(plan?.nodes.map((n) => n.requestedEnvironment) ?? []),
    ]);
    for (const env of environmentsToCheck) {
      if (!context.project.allowedEnvironments.includes(env)) {
        throw new ProgramError(
          "AUTHORITY_DRIFT",
          `Environment ${env} no longer authorized for project`,
        );
      }
    }
    const budgetFp = budgetConfigurationFingerprint(
      context.resourceBudget.budgetProfileId,
      program.delegationEnvelope.maximumProgramBudget,
    );
    if (
      budgetFp !== program.authorityFreeze.budgetConfigurationFingerprint
    ) {
      throw new ProgramError(
        "AUTHORITY_DRIFT",
        "Budget configuration fingerprint drifted since program admission",
      );
    }
    if (
      context.resourceBudget.budgetProfileId !==
      program.authorityFreeze.budgetProfileId
    ) {
      throw new ProgramError(
        "AUTHORITY_DRIFT",
        "Budget profile drifted since program admission",
      );
    }

    // Repository identities are NOT part of projectConfigurationFingerprint.
    // Recheck live control-plane authorization against approved envelope/plan.
    const approvedRepos = new Set(
      program.delegationEnvelope.allowedRepositoryIdentities,
    );
    for (const node of plan?.nodes ?? []) {
      for (const id of node.requestedRepositoryIdentities) {
        approvedRepos.add(id);
      }
    }
    if (approvedRepos.size > 0) {
      if (!this.deps.authorizedRepositoryIdentities) {
        throw new ProgramError(
          "AUTHORITY_DRIFT",
          "Repository authority recheck not configured",
        );
      }
      const current = new Set(
        await this.deps.authorizedRepositoryIdentities(program.projectId),
      );
      for (const id of approvedRepos) {
        if (!current.has(id)) {
          throw new ProgramError(
            "AUTHORITY_DRIFT",
            `Repository ${id} no longer authorized; stale approval cannot preserve revoked scope`,
          );
        }
      }
      // Frozen fingerprint must still describe the approved allowlist.
      if (
        repositoryAllowlistFingerprint(
          program.delegationEnvelope.allowedRepositoryIdentities,
        ) !== program.authorityFreeze.repositoryAllowlistFingerprint
      ) {
        throw new ProgramError(
          "AUTHORITY_DRIFT",
          "Repository allowlist fingerprint drifted on program record",
        );
      }
    }
  }

  private async requireProgram(programId: string): Promise<Program> {
    const program = await this.deps.programs.getById(programId);
    if (!program) {
      throw new ProgramError("PROGRAM_NOT_FOUND", `Program ${programId} not found`);
    }
    return program;
  }

  private async requireLatestPlan(program: Program): Promise<ProgramPlan> {
    const plan = await this.deps.plans.getLatest(program.programId);
    if (!plan) {
      throw new ProgramError("PROGRAM_PLAN_INVALID", "Program plan missing");
    }
    assertValidProgramPlan(program, plan);
    return plan;
  }

  private async transition(
    program: Program,
    next: ProgramState,
    extras: Parameters<ProgramRepository["transition"]>[5] = {},
  ): Promise<Program> {
    if (!canTransitionProgram(program.status, next)) {
      throw new ProgramError(
        "INVALID_PROGRAM_TRANSITION",
        `Illegal transition ${program.status} → ${next}`,
      );
    }
    return this.deps.programs.transition(
      program.programId,
      program.status,
      program.recordRevision,
      next,
      this.deps.nowIso(),
      extras,
    );
  }
}
