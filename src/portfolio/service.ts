import type { ControlPlaneService } from "../control-plane/service.js";
import { capabilitySetFingerprint } from "../execution/capability-fingerprint.js";
import {
  issueDecisionNonce,
  type DecisionNonceGenerator,
} from "../authorization/decision-nonce.js";
import { hashDecisionNonce } from "../authorization/decision-card-hasher.js";
import {
  budgetConfigurationFingerprint,
  projectConfigurationFingerprint,
  repositoryAllowlistFingerprint,
} from "../programs/authority.js";
import {
  parseDelegationEnvelope,
  type DelegationEnvelope,
} from "../programs/delegation-envelope.js";
import type { ProgramRepository } from "../programs/repositories.js";
import type { ProgramCompletionRepository } from "../programs/repositories.js";
import { INITIAL_PROGRAM_VERSION } from "../programs/program.js";
import {
  BUDGET_DIMENSIONS,
  type BudgetDimension,
  type BudgetResourceEstimate,
} from "../control-plane/budgets/budget.js";
import {
  withOptionalTransaction,
  type TransactionManager,
} from "../durability/transaction.js";
import { assertInstitutionalRequirements } from "../governance/phase-gate.js";
import { labelEvidence, type PortfolioAnalysisContext } from "./analysis-context.js";
import {
  portfolioAuthorizationEnvelopeHash,
  parsePortfolioAuthorizationEnvelope,
  type PortfolioAuthorizationEnvelope,
} from "./authorization-envelope.js";
import type {
  ProgramAdmissionRequest,
  ProgramOrchestrationService,
} from "../programs/service.js";
import {
  addBudget,
  canReserve,
  emptyBudgetEstimate,
  portfolioAvailableToReserve,
  reservationIdFor,
} from "./budget.js";
import { compilePortfolioPlan } from "./compiler.js";
import { PortfolioError } from "./errors.js";
import { provePortfolioGoal } from "./goal-proof.js";
import type { PortfolioGoal } from "./goals.js";
import type { PortfolioIntent } from "./intent.js";
import { portfolioIntentHash, mintPortfolioId } from "./intent.js";
import {
  computeAuthorizationSubjectHash,
  portfolioLineageIdFor,
  type PortfolioAuthorizationRecord,
  type PortfolioAuthorizationRequest,
  type PortfolioCompletionRecord,
  type PortfolioProgramLineage,
  type PortfolioProgress,
  type PortfolioRebalanceProposal,
} from "./lineage.js";
import {
  INITIAL_PORTFOLIO_PLAN_VERSION,
  mintProgramIdFromPortfolioProposal,
  type PortfolioPlan,
  type PortfolioProgramProposal,
  type PortfolioProgramReference,
} from "./plan.js";
import {
  INITIAL_PORTFOLIO_VERSION,
  parsePortfolio,
  portfolioContentFingerprint,
  portfolioIdempotencyKey,
  environmentScopeFingerprint,
  type Portfolio,
} from "./portfolio.js";
import { canTransitionPortfolio, type PortfolioState } from "./portfolio-state.js";
import type {
  PortfolioAuthorizationRecordRepository,
  PortfolioAuthorizationRequestRepository,
  PortfolioBudgetLedgerRepository,
  PortfolioBudgetReservationRepository,
  PortfolioCompletionRepository,
  PortfolioPlanRepository,
  PortfolioProgramLineageRepository,
  PortfolioRebalanceRepository,
  PortfolioRepository,
} from "./repositories.js";
import type { PortfolioStrategyModel } from "./strategy-model.js";
import { assertValidPortfolioPlan, validatePortfolioPlan } from "./validator.js";

export type PortfolioCompletionFailpointStage =
  | "AFTER_PORTFOLIO_COMPLETION_RECORD"
  | "AFTER_PORTFOLIO_TRANSITION";

export interface PortfolioCompletionFailpoint {
  hit(stage: PortfolioCompletionFailpointStage): Promise<void>;
}

/** Test/recovery inject: throw after N newly admitted programs in one materialize. */
export interface PortfolioMaterializationFailpoint {
  hit(newlyAdmittedCount: number): Promise<void>;
}

export interface PortfolioAdmissionRequest {
  portfolioId?: string;
  portfolioVersion?: number;
  primaryProjectId: string;
  requesterId: string;
  intent: PortfolioIntent;
  goals: PortfolioGoal[];
  authorizationEnvelope: PortfolioAuthorizationEnvelope;
  requestedEnvironment: string;
  submittedAt: string;
  correlationId?: string;
  traceId?: string;
}

export type PortfolioAdmissionOutcome =
  | { outcome: "ADMITTED"; portfolio: Portfolio }
  | { outcome: "DUPLICATE"; portfolio: Portfolio }
  | {
      outcome: "VERSION_CONFLICT";
      existing: Portfolio;
      message: string;
    };

export interface PortfolioServiceDeps {
  nowIso: () => string;
  portfolios: PortfolioRepository;
  plans: PortfolioPlanRepository;
  budgets: PortfolioBudgetLedgerRepository;
  reservations: PortfolioBudgetReservationRepository;
  lineage: PortfolioProgramLineageRepository;
  authRequests: PortfolioAuthorizationRequestRepository;
  authRecords: PortfolioAuthorizationRecordRepository;
  completions: PortfolioCompletionRepository;
  rebalances: PortfolioRebalanceRepository;
  controlPlane: ControlPlaneService;
  strategyModel: PortfolioStrategyModel;
  nonceGenerator: DecisionNonceGenerator;
  /** Plaintext nonces for delivery (tests / in-process delivery). */
  authorizationNonceStore?: {
    put(authorizationId: string, plaintext: string): Promise<void>;
    take(authorizationId: string): Promise<string | null>;
  };
  /** Distinct from Phase 6 execution approver and program materializer.
   * Must hold PORTFOLIO_ALLOCATOR for EVERY project in the Portfolio envelope.
   */
  isPortfolioAllocator?: (
    principalId: string,
    projectIds: readonly string[],
  ) => Promise<boolean>;
  programOrchestration?: ProgramOrchestrationService;
  programs?: ProgramRepository;
  programCompletions?: ProgramCompletionRepository;
  transactions?: TransactionManager;
  completionFailpoint?: PortfolioCompletionFailpoint;
  materializationFailpoint?: PortfolioMaterializationFailpoint;
  authorizedRepositoryIdentities?: (
    projectId: string,
  ) => Promise<readonly string[]>;
  /**
   * Phase 20 — optional institutional hold gate (no mandate ⇒ unchanged).
   */
  institutionalGovernance?: import("../governance/port.js").InstitutionalGovernancePort;
}

/** Portfolio allocator ≠ Phase 6 execution approver ≠ program materializer. */
export const PORTFOLIO_AUTHORITY_BOUNDARIES = {
  portfolioApproval:
    "Portfolio allocator authorizes strategic plan — not child execution",
  programMaterialization:
    "Program materializer approves decomposition — not portfolio plan",
  phase6Execution:
    "Phase 6 execution approver authorizes run plans — not portfolio plan",
} as const;

export function assertPortfolioAuthoritySeparation(): void {
  // Intentional documentation hook for tests / reviews.
}

export function assertPortfolioApprovalIsDistinctFromProgramMaterialization(): void {
  // Intentional documentation hook for tests / reviews.
}

export function assertPortfolioApprovalIsDistinctFromPhase6Execution(): void {
  // Intentional documentation hook for tests / reviews.
}

export class PortfolioOrchestrationService {
  constructor(private readonly deps: PortfolioServiceDeps) {}

  assertAuthoritySeparation(): void {
    assertPortfolioAuthoritySeparation();
    assertPortfolioApprovalIsDistinctFromProgramMaterialization();
    assertPortfolioApprovalIsDistinctFromPhase6Execution();
  }

  async admit(
    request: PortfolioAdmissionRequest,
  ): Promise<PortfolioAdmissionOutcome> {
    const envelope = parsePortfolioAuthorizationEnvelope(
      request.authorizationEnvelope,
    );
    if (!envelope.allowedProjectIds.includes(request.primaryProjectId)) {
      throw new PortfolioError(
        "PROJECT_OUTSIDE_ENVELOPE",
        "Portfolio primaryProjectId must be listed in authorization envelope",
      );
    }
    const context = await this.deps.controlPlane.resolve(
      request.primaryProjectId,
      request.requestedEnvironment,
    );
    const contentFingerprint = portfolioContentFingerprint({
      intent: request.intent,
      goals: request.goals,
      envelope,
      primaryProjectId: request.primaryProjectId,
    });
    const idempotencyKey = portfolioIdempotencyKey({
      primaryProjectId: request.primaryProjectId,
      contentFingerprint,
      requesterId: request.requesterId,
    });

    const existing =
      await this.deps.portfolios.getByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.contentFingerprint !== contentFingerprint) {
        return {
          outcome: "VERSION_CONFLICT",
          existing,
          message: "Same portfolio identity with different semantic content",
        };
      }
      return { outcome: "DUPLICATE", portfolio: existing };
    }

    const now = request.submittedAt;
    const portfolioId =
      request.portfolioId ??
      mintPortfolioId({
        primaryProjectId: request.primaryProjectId,
        intentHash: portfolioIntentHash(request.intent),
        admittedAt: now,
      });
    const portfolioVersion =
      request.portfolioVersion ?? INITIAL_PORTFOLIO_VERSION;
    const envelopeHash = portfolioAuthorizationEnvelopeHash(envelope);
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

    const portfolio = parsePortfolio({
      portfolioId,
      portfolioVersion,
      primaryProjectId: request.primaryProjectId,
      requesterId: request.requesterId,
      intent: request.intent,
      goals: request.goals,
      authorizationEnvelope: envelope,
      authorityFreeze: {
        policyBundleId: context.activePolicyBundle.policyBundleId,
        policyBundleHash: context.activePolicyBundle.policyHash,
        capabilitySetFingerprint: capabilitySetFingerprint(caps),
        projectConfigurationFingerprint: projectConfigurationFingerprint({
          projectId: request.primaryProjectId,
          activePolicyBundleId: context.project.activePolicyBundleId,
          budgetProfileId: context.project.resourceBudgetProfileId,
          allowedEnvironments: context.project.allowedEnvironments,
          executionMode: context.project.executionMode,
        }),
        budgetProfileId: context.resourceBudget.budgetProfileId,
        budgetConfigurationFingerprint: budgetConfigurationFingerprint(
          context.resourceBudget.budgetProfileId,
          envelope.maximumPortfolioBudget,
        ),
        repositoryAllowlistFingerprint: repositoryAllowlistFingerprint(
          envelope.allowedRepositoryIdentities,
        ),
        environmentScopeFingerprint: environmentScopeFingerprint(
          envelope.allowedEnvironments,
        ),
        authorizationEnvelopeHash: envelopeHash,
        frozenAt: now,
      },
      status: "ADMITTED",
      paused: false,
      createdAt: now,
      updatedAt: now,
      recordRevision: 1,
      correlationId: request.correlationId ?? `corr_${portfolioId}`,
      traceId: request.traceId ?? `trace_${portfolioId}`,
      idempotencyKey,
      contentFingerprint,
    });

    const created = await this.deps.portfolios.create(portfolio);
    await this.deps.budgets.create({
      portfolioId: created.portfolioId,
      portfolioVersion: created.portfolioVersion,
      ceiling: envelope.maximumPortfolioBudget,
      reserved: emptyBudgetEstimate(),
      settled: emptyBudgetEstimate(),
      released: emptyBudgetEstimate(),
      recordRevision: 1,
      updatedAt: now,
    });
    return { outcome: "ADMITTED", portfolio: created };
  }

  async analyze(portfolioId: string): Promise<{
    portfolio: Portfolio;
    analysis: PortfolioAnalysisContext;
  }> {
    let portfolio = await this.requirePortfolio(portfolioId);
    if (portfolio.paused) {
      throw new PortfolioError("PORTFOLIO_PAUSED", "Portfolio is paused");
    }
    if (portfolio.status === "ADMITTED") {
      portfolio = await this.transition(portfolio, "ANALYZING");
    } else if (portfolio.status !== "ANALYZING") {
      throw new PortfolioError(
        "INVALID_PORTFOLIO_TRANSITION",
        `Cannot analyze from ${portfolio.status}`,
      );
    }

    const analysis = await this.buildAnalysisContext(portfolio);
    return { portfolio, analysis };
  }

  async plan(portfolioId: string): Promise<{
    portfolio: Portfolio;
    plan: PortfolioPlan;
  }> {
    let portfolio = await this.requirePortfolio(portfolioId);
    if (portfolio.paused) {
      throw new PortfolioError("PORTFOLIO_PAUSED", "Portfolio is paused");
    }
    if (portfolio.status === "ADMITTED") {
      portfolio = await this.transition(portfolio, "ANALYZING");
    } else if (portfolio.status === "REBALANCE_REQUIRED") {
      portfolio = await this.transition(portfolio, "ANALYZING");
    } else if (portfolio.status === "AWAITING_AUTHORIZATION") {
      portfolio = await this.transition(portfolio, "ANALYZING");
    } else if (portfolio.status === "VALIDATING") {
      portfolio = await this.transition(portfolio, "ANALYZING");
    } else if (portfolio.status !== "ANALYZING") {
      throw new PortfolioError(
        "INVALID_PORTFOLIO_TRANSITION",
        `Cannot plan from ${portfolio.status}`,
      );
    }

    const analysis = await this.buildAnalysisContext(portfolio);
    const existingPrograms = await this.loadExistingProgramReferences(portfolio);
    const proposal = await this.deps.strategyModel.propose({
      portfolio,
      analysis,
      existingPrograms,
    });

    const now = this.deps.nowIso();
    const planVersion =
      (portfolio.portfolioPlanVersion ?? INITIAL_PORTFOLIO_PLAN_VERSION - 1) + 1;
    const compiled = compilePortfolioPlan({
      portfolio,
      proposal,
      portfolioPlanVersion: Math.max(planVersion, INITIAL_PORTFOLIO_PLAN_VERSION),
      createdAt: now,
    });

    const savedPlan = await this.deps.plans.save(compiled);
    const planned = await this.deps.portfolios.transition(
      portfolio.portfolioId,
      portfolio.status,
      portfolio.recordRevision,
      "PLANNED",
      now,
      {
        portfolioPlanVersion: savedPlan.portfolioPlanVersion,
        portfolioPlanHash: savedPlan.portfolioPlanHash,
      },
    );
    return { portfolio: planned, plan: savedPlan };
  }

  async validate(portfolioId: string): Promise<{
    portfolio: Portfolio;
    valid: boolean;
    result: ReturnType<typeof validatePortfolioPlan>;
  }> {
    let portfolio = await this.requirePortfolio(portfolioId);
    if (portfolio.status === "PLANNED") {
      portfolio = await this.transition(portfolio, "VALIDATING");
    } else if (portfolio.status !== "VALIDATING") {
      throw new PortfolioError(
        "INVALID_PORTFOLIO_TRANSITION",
        `Cannot validate from ${portfolio.status}`,
      );
    }
    const plan = await this.deps.plans.getLatest(portfolio.portfolioId);
    if (!plan) {
      throw new PortfolioError("PORTFOLIO_PLAN_INVALID", "Portfolio plan missing");
    }
    const result = validatePortfolioPlan(portfolio, plan);
    if (result.outcome === "BLOCK") {
      const failed = await this.transition(portfolio, "FAILED", {
        failureReasonCode: "PORTFOLIO_PLAN_INVALID",
        failureClass: "STRATEGIC_INCONCLUSIVE",
      });
      return { portfolio: failed, valid: false, result };
    }
    await this.recheckAuthorityFreeze(portfolio, plan);
    const awaiting = await this.transition(
      portfolio,
      "AWAITING_AUTHORIZATION",
    );
    return { portfolio: awaiting, valid: true, result };
  }

  async routeAuthorization(portfolioId: string): Promise<{
    request: PortfolioAuthorizationRequest;
    decisionNonce: string;
  }> {
    const portfolio = await this.requirePortfolio(portfolioId);
    if (portfolio.status !== "AWAITING_AUTHORIZATION") {
      throw new PortfolioError(
        "INVALID_PORTFOLIO_TRANSITION",
        "Authorization routing requires AWAITING_AUTHORIZATION",
      );
    }
    const plan = await this.requireLatestPlan(portfolio);
    const existing = await this.deps.authRequests.getPending(portfolioId);
    if (existing) {
      const stored = await this.deps.authorizationNonceStore?.take(
        existing.authorizationId,
      );
      if (stored) {
        await this.deps.authorizationNonceStore?.put(
          existing.authorizationId,
          stored,
        );
        return { request: existing, decisionNonce: stored };
      }
    }

    const now = this.deps.nowIso();
    const expiresAt = new Date(
      Date.parse(now) + 24 * 60 * 60 * 1000,
    ).toISOString();
    const subjectHash = computeAuthorizationSubjectHash({
      portfolioId: portfolio.portfolioId,
      portfolioVersion: portfolio.portfolioVersion,
      portfolioPlanVersion: plan.portfolioPlanVersion,
      portfolioPlanHash: plan.portfolioPlanHash,
      authorizationEnvelopeHash: plan.authorizationEnvelopeHash,
      policyFingerprint: plan.policyBundleFingerprint,
      capabilityFingerprint: plan.capabilitySetFingerprint,
      budgetFingerprint: plan.budgetConfigurationFingerprint,
      allocationPlanHash: plan.allocationPlanHash,
      expiresAt,
    });
    const issued = issueDecisionNonce(this.deps.nonceGenerator);
    const authorizationId = `par_${portfolio.portfolioId}_${plan.portfolioPlanVersion}`;
    const request: PortfolioAuthorizationRequest = {
      authorizationId,
      portfolioId: portfolio.portfolioId,
      portfolioVersion: portfolio.portfolioVersion,
      portfolioPlanVersion: plan.portfolioPlanVersion,
      portfolioPlanHash: plan.portfolioPlanHash,
      authorizationEnvelopeHash: plan.authorizationEnvelopeHash,
      policyBundleFingerprint: plan.policyBundleFingerprint,
      capabilityFingerprint: plan.capabilitySetFingerprint,
      budgetFingerprint: plan.budgetConfigurationFingerprint,
      projectScopeFingerprint: plan.projectConfigurationFingerprint,
      repositoryAllowlistFingerprint: plan.repositoryAllowlistFingerprint,
      environmentScopeFingerprint: plan.environmentScopeFingerprint,
      allocationPlanHash: plan.allocationPlanHash,
      subjectHash,
      decisionNonceHash: issued.nonceHash,
      status: "PENDING",
      expiresAt,
      createdAt: now,
      recordRevision: 1,
    };
    const saved = await this.deps.authRequests.save(request);
    await this.deps.authorizationNonceStore?.put(
      saved.authorizationId,
      issued.plaintext,
    );
    return { request: saved, decisionNonce: issued.plaintext };
  }

  async decideAuthorization(input: {
    authorizationId: string;
    allocatorId: string;
    decision: "APPROVE" | "REJECT";
    decisionNonce: string;
    submittedAt: string;
    institutionalProofId?: string;
  }): Promise<{
    request: PortfolioAuthorizationRequest;
    record?: PortfolioAuthorizationRecord;
    portfolio: Portfolio;
  }> {
    const request = await this.deps.authRequests.getById(input.authorizationId);
    if (!request || request.status !== "PENDING") {
      throw new PortfolioError(
        "PORTFOLIO_AUTHORIZATION_INVALID",
        "No pending portfolio authorization request",
      );
    }
    if (Date.parse(input.submittedAt) > Date.parse(request.expiresAt)) {
      await this.deps.authRequests.saveCas(
        { ...request, status: "EXPIRED" },
        request.recordRevision,
      );
      throw new PortfolioError(
        "PORTFOLIO_AUTHORIZATION_EXPIRED",
        "Portfolio authorization request expired",
        { authorizationId: request.authorizationId },
      );
    }
    if (hashDecisionNonce(input.decisionNonce) !== request.decisionNonceHash) {
      throw new PortfolioError(
        "PORTFOLIO_AUTHORIZATION_INVALID",
        "Decision nonce mismatch",
      );
    }
    const portfolio = await this.requirePortfolio(request.portfolioId);
    if (input.decision === "APPROVE") {
      const projectId =
        portfolio.authorizationEnvelope.allowedProjectIds[0] ??
        portfolio.primaryProjectId;
      await assertInstitutionalRequirements({
        port: this.deps.institutionalGovernance,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId,
        environment:
          portfolio.authorizationEnvelope.allowedEnvironments[0] ?? "local",
        subjectClass: "PORTFOLIO_AUTHORIZATION",
        subjectType: "PORTFOLIO_AUTHORIZATION",
        subjectId: portfolio.portfolioId,
        subjectHash: request.subjectHash,
        subjectVersion: portfolio.portfolioVersion,
        ...(input.institutionalProofId !== undefined
          ? { institutionalProofId: input.institutionalProofId }
          : {}),
        atIso: input.submittedAt,
      });
    }
    if (!this.deps.isPortfolioAllocator) {
      throw new PortfolioError(
        "PORTFOLIO_AUTHORIZATION_INVALID",
        "PORTFOLIO_ALLOCATOR authority check not configured",
      );
    }
    const projectScope = [
      ...new Set(portfolio.authorizationEnvelope.allowedProjectIds),
    ];
    if (projectScope.length === 0) {
      throw new PortfolioError(
        "PORTFOLIO_AUTHORIZATION_INVALID",
        "Portfolio envelope has empty project scope",
      );
    }
    const allowed = await this.deps.isPortfolioAllocator(
      input.allocatorId,
      projectScope,
    );
    if (!allowed) {
      throw new PortfolioError(
        "PORTFOLIO_AUTHORIZATION_INVALID",
        "Principal lacks PORTFOLIO_ALLOCATOR authority for the full portfolio project scope",
        { projectScope },
      );
    }
    await this.recheckAuthorityFreeze(portfolio);

    const decided = await this.deps.authRequests.saveCas(
      {
        ...request,
        status: input.decision === "APPROVE" ? "APPROVED" : "REJECTED",
        allocatorId: input.allocatorId,
        decidedAt: input.submittedAt,
      },
      request.recordRevision,
    );

    if (input.decision === "REJECT") {
      const replan = await this.transition(portfolio, "ANALYZING");
      return { request: decided, portfolio: replan };
    }

    const record: PortfolioAuthorizationRecord = {
      authorizationRecordId: `parc_${request.authorizationId}`,
      authorizationId: request.authorizationId,
      portfolioId: portfolio.portfolioId,
      portfolioVersion: portfolio.portfolioVersion,
      portfolioPlanVersion: request.portfolioPlanVersion,
      portfolioPlanHash: request.portfolioPlanHash,
      authorizationEnvelopeHash: request.authorizationEnvelopeHash,
      allocationPlanHash: request.allocationPlanHash,
      allocatorId: input.allocatorId,
      decision: "APPROVE",
      subjectHash: request.subjectHash,
      decisionNonceHash: request.decisionNonceHash,
      decidedAt: input.submittedAt,
      expiresAt: request.expiresAt,
      createdAt: this.deps.nowIso(),
    };
    const savedRecord = await this.deps.authRecords.save(record);
    let next = portfolio;
    if (portfolio.status === "AWAITING_AUTHORIZATION") {
      next = await this.transition(portfolio, "AUTHORIZED");
    }
    return { request: decided, record: savedRecord, portfolio: next };
  }

  /**
   * Idempotent per-proposal program admission via Phase 14 program orchestration.
   * Portfolio authorization ≠ program materialization ≠ Phase 6 execution.
   */
  async materializePrograms(portfolioId: string): Promise<{
    portfolio: Portfolio;
    materialized: PortfolioProgramLineage[];
  }> {
    let portfolio = await this.requirePortfolio(portfolioId);
    if (portfolio.paused) {
      throw new PortfolioError("PORTFOLIO_PAUSED", "Portfolio is paused");
    }
    if (portfolio.status === "AWAITING_AUTHORIZATION") {
      throw new PortfolioError(
        "PORTFOLIO_AUTHORIZATION_REQUIRED",
        "Human portfolio authorization required",
      );
    }
    if (
      portfolio.status !== "AUTHORIZED" &&
      portfolio.status !== "ACTIVE"
    ) {
      throw new PortfolioError(
        "INVALID_PORTFOLIO_TRANSITION",
        `Cannot materialize from ${portfolio.status}`,
      );
    }

    const authorization = await this.findApprovedAuthorization(portfolio);
    if (!authorization) {
      throw new PortfolioError(
        "PORTFOLIO_AUTHORIZATION_REQUIRED",
        "No approved portfolio authorization for current plan",
      );
    }
    const plan = await this.requireLatestPlan(portfolio);
    if (
      plan.portfolioPlanHash !== authorization.portfolioPlanHash ||
      plan.portfolioPlanVersion !== authorization.portfolioPlanVersion
    ) {
      throw new PortfolioError(
        "PORTFOLIO_AUTHORIZATION_INVALID",
        "Authorization does not bind current portfolio plan",
      );
    }
    await this.recheckAuthorityFreeze(portfolio, plan);
    if (!this.deps.programOrchestration) {
      throw new PortfolioError(
        "PROGRAM_ADMISSION_FAILED",
        "Program orchestration service not configured",
      );
    }

    const materialized: PortfolioProgramLineage[] = [];
    let newlyAdmitted = 0;
    const createProposals = plan.programProposals.filter(
      (p) => p.disposition === "CREATE_PROGRAM",
    );

    for (const proposal of createProposals) {
      const lineageId = portfolioLineageIdFor({
        portfolioId: portfolio.portfolioId,
        portfolioPlanVersion: plan.portfolioPlanVersion,
        proposalId: proposal.proposalId,
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

      const allocation =
        plan.proposedAllocations.find((a) => a.proposalId === proposal.proposalId)
          ?.amount ?? proposal.requestedAllocation;

      const reservationId = await this.reserveProposalBudget(
        portfolio,
        plan,
        proposal.proposalId,
        allocation,
      );

      const programId = mintProgramIdFromPortfolioProposal({
        portfolioId: portfolio.portfolioId,
        portfolioVersion: portfolio.portfolioVersion,
        portfolioPlanVersion: plan.portfolioPlanVersion,
        proposalId: proposal.proposalId,
      });

      const now = this.deps.nowIso();
      const delegationEnvelope = buildProgramDelegationEnvelope(
        portfolio,
        proposal,
        allocation,
      );
      const admissionRequest: ProgramAdmissionRequest = {
        programId,
        programVersion: INITIAL_PROGRAM_VERSION,
        projectId: proposal.projectId,
        requesterId: portfolio.requesterId,
        requestedEnvironment: proposal.requestedEnvironment,
        rootIntent: proposal.proposedProgramRootIntent,
        delegationEnvelope,
        submittedAt: now,
        correlationId: portfolio.correlationId,
        traceId: portfolio.traceId,
      };

      let status: PortfolioProgramLineage["materializationStatus"] = "FAILED";
      let failureReasonCode: string | undefined;
      try {
        const result =
          await this.deps.programOrchestration.admit(admissionRequest);
        status =
          result.outcome === "ADMITTED"
            ? "ADMITTED"
            : result.outcome === "DUPLICATE"
              ? "DUPLICATE"
              : "FAILED";
        if (status === "FAILED") {
          failureReasonCode =
            result.outcome === "VERSION_CONFLICT"
              ? "VERSION_CONFLICT"
              : "ADMISSION_REJECTED";
        }
      } catch (err) {
        failureReasonCode =
          err instanceof PortfolioError ? err.code : "PROGRAM_ADMISSION_FAILED";
      }

      const record: PortfolioProgramLineage = {
        lineageId,
        portfolioId: portfolio.portfolioId,
        portfolioVersion: portfolio.portfolioVersion,
        portfolioPlanVersion: plan.portfolioPlanVersion,
        portfolioPlanHash: plan.portfolioPlanHash,
        proposalId: proposal.proposalId,
        programId,
        programVersion: INITIAL_PROGRAM_VERSION,
        allocationId: reservationId,
        goalBindings: [...proposal.goalContributionBindings],
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

    portfolio = await this.requirePortfolio(portfolioId);
    if (portfolio.status === "AUTHORIZED") {
      portfolio = await this.transition(portfolio, "ACTIVE");
    }
    return { portfolio, materialized };
  }

  async reconcile(portfolioId: string): Promise<PortfolioProgress> {
    const portfolio = await this.requirePortfolio(portfolioId);
    const plan = await this.deps.plans.getLatest(portfolioId);
    const lineage = plan
      ? await this.deps.lineage.listByPlan(
          portfolioId,
          plan.portfolioPlanVersion,
        )
      : await this.deps.lineage.listByPortfolio(portfolioId);

    const programCountsByState: Record<string, number> = {};
    let completedCount = 0;
    const stalledPrograms: string[] = [];

    for (const link of lineage) {
      if (!this.deps.programs) {
        continue;
      }
      const program = await this.deps.programs.getById(link.programId);
      const state = program?.status ?? "UNKNOWN";
      programCountsByState[state] = (programCountsByState[state] ?? 0) + 1;
      if (program?.status === "COMPLETED") {
        completedCount += 1;
      } else if (
        program &&
        !["COMPLETED", "CANCELLED", "FAILED"].includes(program.status)
      ) {
        stalledPrograms.push(link.programId);
      }
    }

    const ledger = await this.deps.budgets.get(portfolioId);
    const reservations = await this.deps.reservations.listByPortfolio(
      portfolioId,
    );
    const reservedBudget = reservations
      .filter((r) => r.status === "RESERVED")
      .reduce((acc, r) => addBudget(acc, r.amount), emptyBudgetEstimate());

    const requiredGoals = portfolio.goals.filter(
      (g) => g.classification === "REQUIRED",
    );
    const goalCoverage = requiredGoals.map((goal) => ({
      goalId: goal.goalId,
      status: goal.status,
    }));

    const rebalanceRequired = portfolio.status === "REBALANCE_REQUIRED";
    const totalPrograms = lineage.length;
    const observationalProgressPercent =
      totalPrograms > 0
        ? Math.round((completedCount / totalPrograms) * 100)
        : undefined;

    return {
      portfolioId,
      programCountsByState,
      ...(ledger ? { allocatedBudget: ledger.ceiling } : {}),
      reservedBudget,
      goalCoverage,
      stalledPrograms,
      rebalanceRequired,
      ...(observationalProgressPercent !== undefined
        ? { observationalProgressPercent }
        : {}),
      computedAt: this.deps.nowIso(),
    };
  }

  async proposeRebalance(
    portfolioId: string,
    trigger: PortfolioRebalanceProposal["trigger"],
  ): Promise<{
    portfolio: Portfolio;
    proposal: PortfolioRebalanceProposal;
  }> {
    const portfolio = await this.requirePortfolio(portfolioId);
    if (
      portfolio.status !== "ACTIVE" &&
      portfolio.status !== "VERIFYING" &&
      portfolio.status !== "REBALANCE_REQUIRED"
    ) {
      throw new PortfolioError(
        "INVALID_PORTFOLIO_TRANSITION",
        `Cannot propose rebalance from ${portfolio.status}`,
      );
    }

    const now = this.deps.nowIso();
    const rebalanceId = `prb_${portfolioId}_${now}`;
    const proposal: PortfolioRebalanceProposal = {
      rebalanceId,
      portfolioId: portfolio.portfolioId,
      portfolioVersion: portfolio.portfolioVersion,
      trigger,
      rationale: `Rebalance triggered by ${trigger}`,
      proposedDispositions: [],
      requiresNewAuthorization: true,
      createdAt: now,
      status: "PROPOSED",
    };
    const saved = await this.deps.rebalances.save(proposal);

    let next = portfolio;
    if (
      portfolio.status === "ACTIVE" ||
      portfolio.status === "VERIFYING"
    ) {
      next = await this.transition(portfolio, "REBALANCE_REQUIRED", {
        failureClass: "REBALANCE_REQUIRED",
      });
    }
    return { portfolio: next, proposal: saved };
  }

  async verify(portfolioId: string): Promise<{
    portfolio: Portfolio;
    outcome: string;
    completion?: PortfolioCompletionRecord;
  }> {
    let portfolio = await this.requirePortfolio(portfolioId);
    const existingCompletion =
      await this.deps.completions.getByPortfolioId(portfolioId);
    if (existingCompletion && portfolio.status === "COMPLETED") {
      return {
        portfolio,
        outcome: "VERIFIED_SUCCESS",
        completion: existingCompletion,
      };
    }

    if (portfolio.status === "ACTIVE") {
      try {
        portfolio = await this.transition(portfolio, "VERIFYING");
      } catch {
        portfolio = await this.requirePortfolio(portfolioId);
        if (portfolio.status === "COMPLETED") {
          const done = await this.deps.completions.getByPortfolioId(portfolioId);
          if (done) {
            return {
              portfolio,
              outcome: "VERIFIED_SUCCESS",
              completion: done,
            };
          }
        }
        if (portfolio.status !== "VERIFYING") {
          throw new PortfolioError(
            "INVALID_PORTFOLIO_TRANSITION",
            `Cannot verify from ${portfolio.status}`,
          );
        }
      }
    } else if (portfolio.status !== "VERIFYING") {
      throw new PortfolioError(
        "INVALID_PORTFOLIO_TRANSITION",
        `Cannot verify from ${portfolio.status}`,
      );
    }

    const plan = await this.requireLatestPlan(portfolio);
    const lineage = await this.deps.lineage.listByPlan(
      portfolio.portfolioId,
      plan.portfolioPlanVersion,
    );
    const programsById = new Map<string, Awaited<
      ReturnType<NonNullable<PortfolioServiceDeps["programs"]>["getById"]>
    > | null>();
    const programCompletionsById = new Map<
      string,
      Awaited<
        ReturnType<
          NonNullable<PortfolioServiceDeps["programCompletions"]>["getByProgram"]
        >
      > | null
    >();

    for (const link of lineage) {
      if (this.deps.programs) {
        programsById.set(
          link.programId,
          await this.deps.programs.getById(link.programId),
        );
      }
      if (this.deps.programCompletions) {
        programCompletionsById.set(
          link.programId,
          await this.deps.programCompletions.getByProgram(link.programId),
        );
      }
    }

    const requiredGoals = portfolio.goals.filter(
      (g) => g.classification === "REQUIRED",
    );
    const goalResults: PortfolioCompletionRecord["goalResults"] = [];

    for (const goal of requiredGoals) {
      const proof = provePortfolioGoal({
        portfolio,
        plan,
        goalId: goal.goalId,
        lineage,
        programsById,
        programCompletionsById,
      });
      if (proof.status !== "SATISFIED") {
        if (proof.status === "UNSATISFIED") {
          const failed = await this.transition(portfolio, "FAILED", {
            failureReasonCode: proof.reasonCode,
            failureClass: "PORTFOLIO_GOAL_FAILURE",
          });
          return { portfolio: failed, outcome: "PORTFOLIO_FAILED" };
        }
        const inconclusive = await this.transition(portfolio, "ACTIVE", {
          failureReasonCode: proof.reasonCode,
          failureClass: "INSUFFICIENT_EVIDENCE",
        });
        return { portfolio: inconclusive, outcome: "INCONCLUSIVE" };
      }
      goalResults.push({
        goalId: goal.goalId,
        satisfied: true,
        evidenceRefs: proof.evidenceRefs,
      });
    }

    const now = this.deps.nowIso();
    const completion: PortfolioCompletionRecord = {
      portfolioCompletionRecordId: `pcr_${portfolio.portfolioId}`,
      portfolioId: portfolio.portfolioId,
      portfolioVersion: portfolio.portfolioVersion,
      portfolioPlanVersion: plan.portfolioPlanVersion,
      portfolioPlanHash: plan.portfolioPlanHash,
      outcome: "VERIFIED_SUCCESS",
      goalResults,
      createdAt: now,
    };

    const completed = await withOptionalTransaction(
      this.deps.transactions,
      async () => {
        const raced = await this.deps.completions.getByPortfolioId(portfolioId);
        if (raced) {
          const live = await this.requirePortfolio(portfolioId);
          if (live.status === "COMPLETED") {
            return live;
          }
        }
        await this.deps.completions.save(completion);
        await this.deps.completionFailpoint?.hit(
          "AFTER_PORTFOLIO_COMPLETION_RECORD",
        );
        const live = await this.requirePortfolio(portfolioId);
        if (live.status === "COMPLETED") {
          return live;
        }
        const next = await this.transition(live, "COMPLETED");
        await this.deps.completionFailpoint?.hit("AFTER_PORTFOLIO_TRANSITION");
        return next;
      },
    );
    const saved =
      (await this.deps.completions.getByPortfolioId(portfolioId)) ??
      completion;
    return {
      portfolio: completed,
      outcome: "VERIFIED_SUCCESS",
      completion: saved,
    };
  }

  async pause(portfolioId: string): Promise<Portfolio> {
    const portfolio = await this.requirePortfolio(portfolioId);
    if (portfolio.status === "ACTIVE") {
      return this.deps.portfolios.transition(
        portfolio.portfolioId,
        "ACTIVE",
        portfolio.recordRevision,
        "PAUSED",
        this.deps.nowIso(),
        { paused: true },
      );
    }
    return this.deps.portfolios.save(
      { ...portfolio, paused: true, updatedAt: this.deps.nowIso() },
      portfolio.recordRevision,
    );
  }

  private async buildAnalysisContext(
    portfolio: Portfolio,
  ): Promise<PortfolioAnalysisContext> {
    const env =
      portfolio.authorizationEnvelope.allowedEnvironments[0] ??
      portfolio.intent.requestedEnvironmentScopes[0]!;
    const context = await this.deps.controlPlane.resolve(
      portfolio.primaryProjectId,
      env,
    );
    const now = this.deps.nowIso();
    const evidence = [
      labelEvidence(
        "CURRENT_CONTROL_PLANE_TRUTH",
        "activePolicyBundle",
        context.activePolicyBundle,
      ),
      labelEvidence(
        "CURRENT_CONTROL_PLANE_TRUTH",
        "projectConfiguration",
        context.project,
      ),
      labelEvidence(
        "CURRENT_CONTROL_PLANE_TRUTH",
        "resourceBudget",
        context.resourceBudget,
      ),
      labelEvidence(
        "CURRENT_CONTROL_PLANE_TRUTH",
        "availableCapabilities",
        context.availableCapabilities,
      ),
    ];

    const existingPrograms = await this.loadExistingProgramReferences(portfolio);
    if (existingPrograms.length > 0) {
      evidence.push(
        labelEvidence(
          "PROGRAM_COMPLETION_AUTHORITY",
          "existingPrograms",
          existingPrograms,
        ),
      );
    }

    return {
      portfolioId: portfolio.portfolioId,
      portfolioVersion: portfolio.portfolioVersion,
      evidence,
      builtAt: now,
    };
  }

  private async loadExistingProgramReferences(
    portfolio: Portfolio,
  ): Promise<PortfolioProgramReference[]> {
    const plan = await this.deps.plans.getLatest(portfolio.portfolioId);
    if (!plan || !this.deps.programs) {
      return [];
    }
    const lineage = await this.deps.lineage.listByPlan(
      portfolio.portfolioId,
      plan.portfolioPlanVersion,
    );
    const refs: PortfolioProgramReference[] = [];
    for (const link of lineage) {
      const program = await this.deps.programs.getById(link.programId);
      if (!program) {
        continue;
      }
      refs.push({
        programId: program.programId,
        programVersion: program.programVersion,
        programStatus: program.status,
        programPlanVersion: program.programPlanVersion,
        programPlanHash: program.programPlanHash,
        projectId: program.projectId,
        repositoryScope: [
          ...program.delegationEnvelope.allowedRepositoryIdentities,
        ],
        environmentScope: [
          ...program.delegationEnvelope.allowedEnvironments,
        ],
        goalContributionBindings: [...link.goalBindings],
      });
    }
    return refs;
  }

  private async findApprovedAuthorization(
    portfolio: Portfolio,
  ): Promise<PortfolioAuthorizationRecord | null> {
    const plan = await this.deps.plans.getLatest(portfolio.portfolioId);
    if (!plan) {
      return null;
    }
    const authorizationId = `par_${portfolio.portfolioId}_${plan.portfolioPlanVersion}`;
    const record =
      await this.deps.authRecords.getByAuthorizationId(authorizationId);
    return record?.decision === "APPROVE" ? record : null;
  }

  private async reserveProposalBudget(
    portfolio: Portfolio,
    plan: PortfolioPlan,
    proposalId: string,
    amount: BudgetResourceEstimate,
  ): Promise<string> {
    const reservationId = reservationIdFor({
      portfolioId: portfolio.portfolioId,
      portfolioPlanVersion: plan.portfolioPlanVersion,
      proposalId,
    });
    const existing = await this.deps.reservations.getById(reservationId);
    if (existing && existing.status !== "RELEASED") {
      return reservationId;
    }
    const ledger = await this.deps.budgets.get(portfolio.portfolioId);
    if (!ledger) {
      throw new PortfolioError(
        "PORTFOLIO_BUDGET_OVER_ALLOCATION",
        "Budget ledger missing",
      );
    }
    const available = portfolioAvailableToReserve(ledger);
    if (!canReserve(available, amount)) {
      throw new PortfolioError(
        "PORTFOLIO_BUDGET_OVER_ALLOCATION",
        "Insufficient portfolio budget remaining",
        { proposalId, available, amount },
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
      portfolioId: portfolio.portfolioId,
      portfolioPlanVersion: plan.portfolioPlanVersion,
      proposalId,
      amount,
      status: "RESERVED",
      createdAt: now,
      updatedAt: now,
      recordRevision: 1,
    });
    return reservationId;
  }

  private async recheckAuthorityFreeze(
    portfolio: Portfolio,
    plan?: PortfolioPlan,
  ): Promise<void> {
    const env =
      portfolio.authorizationEnvelope.allowedEnvironments[0] ??
      portfolio.intent.requestedEnvironmentScopes[0]!;
    const context = await this.deps.controlPlane.resolve(
      portfolio.primaryProjectId,
      env,
    );
    if (
      context.activePolicyBundle.policyHash !==
      portfolio.authorityFreeze.policyBundleHash
    ) {
      throw new PortfolioError(
        "AUTHORITY_DRIFT",
        "Policy bundle hash drifted since portfolio admission",
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
      portfolio.authorityFreeze.capabilitySetFingerprint
    ) {
      throw new PortfolioError(
        "AUTHORITY_DRIFT",
        "Capability set fingerprint drifted since portfolio admission",
      );
    }
    const projectFp = projectConfigurationFingerprint({
      projectId: portfolio.primaryProjectId,
      activePolicyBundleId: context.project.activePolicyBundleId,
      budgetProfileId: context.project.resourceBudgetProfileId,
      allowedEnvironments: context.project.allowedEnvironments,
      executionMode: context.project.executionMode,
    });
    if (
      projectFp !== portfolio.authorityFreeze.projectConfigurationFingerprint
    ) {
      throw new PortfolioError(
        "AUTHORITY_DRIFT",
        "Project configuration fingerprint drifted since portfolio admission",
      );
    }
    const environmentsToCheck = new Set<string>([
      ...portfolio.authorizationEnvelope.allowedEnvironments,
      ...(plan?.programProposals.map((p) => p.requestedEnvironment) ?? []),
    ]);
    for (const environment of environmentsToCheck) {
      if (!context.project.allowedEnvironments.includes(environment)) {
        throw new PortfolioError(
          "AUTHORITY_DRIFT",
          `Environment ${environment} no longer authorized for project`,
        );
      }
    }
    const budgetFp = budgetConfigurationFingerprint(
      context.resourceBudget.budgetProfileId,
      portfolio.authorizationEnvelope.maximumPortfolioBudget,
    );
    if (
      budgetFp !== portfolio.authorityFreeze.budgetConfigurationFingerprint
    ) {
      throw new PortfolioError(
        "AUTHORITY_DRIFT",
        "Budget configuration fingerprint drifted since portfolio admission",
      );
    }
    if (
      context.resourceBudget.budgetProfileId !==
      portfolio.authorityFreeze.budgetProfileId
    ) {
      throw new PortfolioError(
        "AUTHORITY_DRIFT",
        "Budget profile drifted since portfolio admission",
      );
    }

    const approvedRepos = new Set(
      portfolio.authorizationEnvelope.allowedRepositoryIdentities,
    );
    for (const proposal of plan?.programProposals ?? []) {
      for (const id of proposal.repositoryScope) {
        approvedRepos.add(id);
      }
    }
    if (approvedRepos.size > 0) {
      if (!this.deps.authorizedRepositoryIdentities) {
        throw new PortfolioError(
          "AUTHORITY_DRIFT",
          "Repository authority recheck not configured",
        );
      }
      const current = new Set(
        await this.deps.authorizedRepositoryIdentities(
          portfolio.primaryProjectId,
        ),
      );
      for (const id of approvedRepos) {
        if (!current.has(id)) {
          throw new PortfolioError(
            "AUTHORITY_DRIFT",
            `Repository ${id} no longer authorized; stale approval cannot preserve revoked scope`,
          );
        }
      }
      if (
        repositoryAllowlistFingerprint(
          portfolio.authorizationEnvelope.allowedRepositoryIdentities,
        ) !== portfolio.authorityFreeze.repositoryAllowlistFingerprint
      ) {
        throw new PortfolioError(
          "AUTHORITY_DRIFT",
          "Repository allowlist fingerprint drifted on portfolio record",
        );
      }
    }

    if (
      portfolioAuthorizationEnvelopeHash(
        portfolio.authorizationEnvelope,
      ) !== portfolio.authorityFreeze.authorizationEnvelopeHash
    ) {
      throw new PortfolioError(
        "AUTHORITY_DRIFT",
        "Authorization envelope hash drifted on portfolio record",
      );
    }
  }

  private async requirePortfolio(portfolioId: string): Promise<Portfolio> {
    const portfolio = await this.deps.portfolios.getById(portfolioId);
    if (!portfolio) {
      throw new PortfolioError(
        "PORTFOLIO_NOT_FOUND",
        `Portfolio ${portfolioId} not found`,
      );
    }
    return portfolio;
  }

  private async requireLatestPlan(portfolio: Portfolio): Promise<PortfolioPlan> {
    const plan = await this.deps.plans.getLatest(portfolio.portfolioId);
    if (!plan) {
      throw new PortfolioError("PORTFOLIO_PLAN_INVALID", "Portfolio plan missing");
    }
    assertValidPortfolioPlan(portfolio, plan);
    return plan;
  }

  private async transition(
    portfolio: Portfolio,
    next: PortfolioState,
    extras: Parameters<PortfolioRepository["transition"]>[5] = {},
  ): Promise<Portfolio> {
    if (!canTransitionPortfolio(portfolio.status, next)) {
      throw new PortfolioError(
        "INVALID_PORTFOLIO_TRANSITION",
        `Illegal transition ${portfolio.status} → ${next}`,
      );
    }
    return this.deps.portfolios.transition(
      portfolio.portfolioId,
      portfolio.status,
      portfolio.recordRevision,
      next,
      this.deps.nowIso(),
      extras,
    );
  }
}

function buildProgramDelegationEnvelope(
  portfolio: Portfolio,
  proposal: PortfolioProgramProposal,
  allocation: BudgetResourceEstimate,
): DelegationEnvelope {
  const portfolioEnvelope = portfolio.authorizationEnvelope;
  const proposed = proposal.proposedDelegationEnvelope;

  const allowedProjectIds = intersectSorted(
    proposed?.allowedProjectIds ?? [proposal.projectId],
    portfolioEnvelope.allowedProjectIds,
  );
  if (allowedProjectIds.length === 0) {
    throw new PortfolioError(
      "PROJECT_OUTSIDE_ENVELOPE",
      `Proposal ${proposal.proposalId} project outside portfolio envelope`,
    );
  }

  const allowedEnvironments = intersectSorted(
    proposed?.allowedEnvironments ?? [proposal.requestedEnvironment],
    portfolioEnvelope.allowedEnvironments,
  );
  if (allowedEnvironments.length === 0) {
    throw new PortfolioError(
      "ENVIRONMENT_OUTSIDE_ENVELOPE",
      `Proposal ${proposal.proposalId} environment outside portfolio envelope`,
    );
  }

  const allowedRepositoryIdentities = intersectSorted(
    proposed?.allowedRepositoryIdentities ?? proposal.repositoryScope,
    portfolioEnvelope.allowedRepositoryIdentities,
  );
  if (
    (proposed?.allowedRepositoryIdentities ?? proposal.repositoryScope)
      .length > 0 &&
    allowedRepositoryIdentities.length !==
      (proposed?.allowedRepositoryIdentities ?? proposal.repositoryScope)
        .length
  ) {
    throw new PortfolioError(
      "REPOSITORY_OUTSIDE_ENVELOPE",
      `Proposal ${proposal.proposalId} repository outside portfolio envelope`,
    );
  }

  const allowedCapabilityIds = intersectSorted(
    proposed?.allowedCapabilityIds ?? portfolioEnvelope.allowedCapabilityIds,
    portfolioEnvelope.allowedCapabilityIds,
  );
  if (
    (proposed?.allowedCapabilityIds ?? []).length > 0 &&
    allowedCapabilityIds.length !== proposed!.allowedCapabilityIds.length
  ) {
    throw new PortfolioError(
      "CAPABILITY_EXPANSION_REJECTED",
      `Proposal ${proposal.proposalId} capability expansion rejected`,
    );
  }

  const maximumProgramBudget = intersectBudgetEstimate(
    allocation,
    portfolioEnvelope.maximumProgramAllocation,
  );
  const maximumChildBudget = intersectBudgetEstimate(
    maximumProgramBudget,
    proposed?.maximumChildBudget ?? maximumProgramBudget,
  );

  return parseDelegationEnvelope({
    allowedProjectIds,
    allowedEnvironments,
    allowedRepositoryIdentities,
    allowedCapabilityIds,
    maximumProgramBudget,
    maximumChildBudget,
    maximumChildren: Math.min(
      proposed?.maximumChildren ?? 12,
      portfolioEnvelope.maximumProgramCount,
    ),
    maximumDepth: proposed?.maximumDepth ?? 3,
    maximumFanOut: proposed?.maximumFanOut ?? 6,
    maximumConcurrentChildren: Math.min(
      proposed?.maximumConcurrentChildren ?? 4,
      portfolioEnvelope.maximumConcurrentPrograms,
    ),
    maximumModelCalls: Math.min(
      proposed?.maximumModelCalls ?? portfolioEnvelope.maximumModelCalls,
      portfolioEnvelope.maximumModelCalls,
    ),
    maximumTotalTokens: Math.min(
      proposed?.maximumTotalTokens ?? portfolioEnvelope.maximumTotalTokens,
      portfolioEnvelope.maximumTotalTokens,
    ),
    crossProjectDelegationAllowed:
      portfolioEnvelope.crossProjectDelegationAllowed &&
      (proposed?.crossProjectDelegationAllowed ?? false),
    materializationApprovalRequired: true,
    ...(proposed?.deadline !== undefined ? { deadline: proposed.deadline } : {}),
  });
}

function intersectSorted(a: readonly string[], b: readonly string[]): string[] {
  const setB = new Set(b);
  return [...new Set(a.filter((x) => setB.has(x)))].sort();
}

function intersectBudgetEstimate(
  a: BudgetResourceEstimate,
  b: BudgetResourceEstimate,
): BudgetResourceEstimate {
  const result = emptyBudgetEstimate();
  for (const dim of BUDGET_DIMENSIONS) {
    result[dim as BudgetDimension] = Math.min(
      a[dim as BudgetDimension],
      b[dim as BudgetDimension],
    );
  }
  return result;
}
