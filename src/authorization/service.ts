import type { ClockPort } from "../infrastructure/clock.js";
import { commitRunTransition } from "../admission/run-transition.js";
import type { RunRepository } from "../admission/run-repository.js";
import type { ObjectiveRepository } from "../admission/objective-repository.js";
import type { ControlPlaneService } from "../control-plane/service.js";
import type { PlanRepository } from "../planning/plan-repository.js";
import type { ValidationDecisionRepository } from "../validation/decision-repository.js";
import type { LockedRepositoryStore } from "../ingestion/locked-state.js";
import { assertInstitutionalRequirements } from "../governance/phase-gate.js";
import {
  parseAuthorizationRecord,
  parseHumanAuthorizationDecision,
  parseModificationRequest,
  type ApprovalRequest,
  type HumanAuthorizationDecision,
} from "../domain/authorization/index.js";
import { Sha256PlanHasher } from "../domain/plan/plan-hasher.js";
import { assertTransition } from "../domain/run/run-state.js";
import type { ApproverAuthorizationService } from "./approver-authorization.js";
import type { ApprovalRequestRepository } from "./approval-request-repository.js";
import type { AuthorizationRecordRepository } from "./authorization-record-repository.js";
import type { ModificationRequestRepository } from "./modification-request-repository.js";
import type { AuthorizationCoordinator } from "./coordinator.js";
import type { DecisionCardStore } from "./decision-card-store.js";
import type { ApprovalDeliveryService } from "./delivery.js";
import {
  Sha256DecisionCardHasher,
  type DecisionCardHasher,
} from "./decision-card-hasher.js";
import {
  buildApprovalDecisionCard,
  whyApprovalRequiredForDecision,
} from "./decision-card-builder.js";
import {
  isExpired,
  SequenceAuthorizationIdentityGenerator,
  DEFAULT_APPROVAL_WINDOW_MS,
  addMsIso,
  type AuthorizationIdentityGenerator,
} from "./identity.js";
import {
  CryptoDecisionNonceGenerator,
  issueDecisionNonce,
  type DecisionNonceGenerator,
} from "./decision-nonce.js";
import { AuthorizationError } from "./errors.js";
import type { AuthorizationResult } from "./result.js";
import { approvalBindingKey } from "../domain/authorization/index.js";
import {
  isTerminalApprovalRequestStatus,
  parseApprovalRequest,
} from "../domain/authorization/index.js";
import {
  capabilitySetFingerprint,
  uniqueCapabilitiesForPlanActions,
} from "../execution/capability-fingerprint.js";
import {
  withOptionalTransaction,
  type TransactionManager,
} from "../durability/transaction.js";

export interface HumanAuthorizationServiceDeps {
  runs: RunRepository;
  objectives: ObjectiveRepository;
  controlPlane: ControlPlaneService;
  plans: PlanRepository;
  decisions: ValidationDecisionRepository;
  locks: LockedRepositoryStore;
  requests: ApprovalRequestRepository;
  records: AuthorizationRecordRepository;
  modifications: ModificationRequestRepository;
  cards: DecisionCardStore;
  coordinator: AuthorizationCoordinator;
  approvers: ApproverAuthorizationService;
  clock: ClockPort;
  /** Required for burned-nonce ApprovalRequest replacement. */
  delivery: ApprovalDeliveryService;
  identities?: AuthorizationIdentityGenerator;
  cardHasher?: DecisionCardHasher;
  planHasher?: Sha256PlanHasher;
  transactions?: TransactionManager;
  nonceGenerator?: DecisionNonceGenerator;
  approvalWindowMs?: number;
  /**
   * Phase 20 — optional institutional hold/proof gate.
   * When absent or no active mandate/hold: Phase 6 behavior unchanged.
   */
  institutionalGovernance?: import("../governance/port.js").InstitutionalGovernancePort;
}

export interface ApprovalReissueResult {
  runId: string;
  replacedApprovalRequestId: string;
  approvalRequestId: string;
  decisionCardHash: string;
  planId: string;
  planVersion: number;
  planHash: string;
  runState: "AWAITING_APPROVAL";
  replacesApprovalRequestId: string;
}

/**
 * Deterministic human authorization. No model calls.
 *
 * APPROVED = human authorization exists for exact plan binding.
 * APPROVED does not mean execution has occurred.
 * Only Phase 6 may transition AWAITING_APPROVAL → APPROVED.
 */
export class HumanAuthorizationService {
  private readonly identities: AuthorizationIdentityGenerator;
  private readonly cardHasher: DecisionCardHasher;
  private readonly planHasher: Sha256PlanHasher;
  private readonly nonceGenerator: DecisionNonceGenerator;
  private readonly approvalWindowMs: number;

  constructor(private readonly deps: HumanAuthorizationServiceDeps) {
    this.identities =
      deps.identities ?? new SequenceAuthorizationIdentityGenerator();
    this.cardHasher = deps.cardHasher ?? new Sha256DecisionCardHasher();
    this.planHasher = deps.planHasher ?? new Sha256PlanHasher();
    this.nonceGenerator =
      deps.nonceGenerator ?? new CryptoDecisionNonceGenerator();
    this.approvalWindowMs =
      deps.approvalWindowMs ?? DEFAULT_APPROVAL_WINDOW_MS;
  }

  async decide(
    input: HumanAuthorizationDecision,
  ): Promise<AuthorizationResult> {
    const decision = parseHumanAuthorizationDecision(input);
    const request = await this.deps.requests.getById(
      decision.approvalRequestId,
    );
    if (!request) {
      throw new AuthorizationError(
        "APPROVAL_REQUEST_NOT_FOUND",
        `Unknown approval request: ${decision.approvalRequestId}`,
      );
    }

    const existingRecord = await this.deps.records.getByApprovalRequest(
      request.approvalRequestId,
    );
    if (existingRecord) {
      return {
        runId: request.runId,
        approvalRequestId: request.approvalRequestId,
        planId: request.planId,
        planVersion: request.planVersion,
        planHash: request.planHash,
        result: "ALREADY_DECIDED",
        authorizationRecordId: existingRecord.authorizationRecordId,
        requiresFurtherAction: false,
        runState:
          (await this.deps.runs.getById(request.runId))?.state ??
          "AWAITING_APPROVAL",
      };
    }

    if (this.deps.institutionalGovernance && decision.decision === "APPROVE") {
      const run = await this.deps.runs.getById(request.runId);
      if (run) {
        await assertInstitutionalRequirements({
          port: this.deps.institutionalGovernance,
          requiredRole: "APPROVER",
          projectId: run.projectId,
          environment: run.requestedEnvironment,
          subjectClass: "PHASE6_APPROVAL",
          subjectType: "PHASE6_APPROVAL",
          subjectId: request.approvalRequestId,
          subjectHash: request.planHash,
          ...(decision.institutionalProofId !== undefined
            ? { institutionalProofId: decision.institutionalProofId }
            : {}),
          atIso: this.deps.clock.nowIso(),
        });
      }
    }

    if (request.status === "EXPIRED") {
      throw new AuthorizationError(
        "APPROVAL_REQUEST_EXPIRED",
        "Approval request has expired",
        { approvalRequestId: request.approvalRequestId },
      );
    }

    if (request.status !== "PENDING") {
      throw new AuthorizationError(
        "APPROVAL_REQUEST_NOT_PENDING",
        `Approval request is ${request.status}, expected PENDING`,
        { approvalRequestId: request.approvalRequestId },
      );
    }

    const now = this.deps.clock.nowIso();
    if (
      isExpired(request.expiresAt, decision.submittedAt) ||
      isExpired(request.expiresAt, now)
    ) {
      await this.deps.requests.updateStatus(
        request.approvalRequestId,
        "EXPIRED",
        { failureReasonCode: "APPROVAL_REQUEST_EXPIRED" },
      );
      await this.deps.coordinator.invalidateNonce(request.approvalRequestId);
      const run = await this.deps.runs.getById(request.runId);
      if (run && run.state === "AWAITING_APPROVAL") {
        const next = assertTransition(run.state, "EXPIRED");
        await commitRunTransition(this.deps.runs, run, next, now);
      }
      throw new AuthorizationError(
        "APPROVAL_REQUEST_EXPIRED",
        "Approval request has expired",
        { approvalRequestId: request.approvalRequestId },
      );
    }

    const { nonceHash } = await this.deps.coordinator.beginDecision(
      request.approvalRequestId,
      decision.decisionNonce,
    );

    try {
      const run = await this.deps.runs.getById(request.runId);
      if (!run || run.state !== "AWAITING_APPROVAL") {
        throw new AuthorizationError(
          "INVALID_AUTHORIZATION_STATE",
          `Run is not AWAITING_APPROVAL`,
          { runId: request.runId, state: run?.state },
        );
      }

      const authz = await this.deps.approvers.authorize({
        approverId: decision.approverId,
        projectId: request.projectId,
        requestedEnvironment: run.requestedEnvironment,
        approvalRequest: request,
      });
      if (authz.outcome === "UNKNOWN_APPROVER") {
        throw new AuthorizationError(
          "UNKNOWN_APPROVER",
          `Unknown approver: ${decision.approverId}`,
        );
      }
      if (authz.outcome !== "AUTHORIZED") {
        throw new AuthorizationError(
          "APPROVER_UNAUTHORIZED",
          `Approver ${decision.approverId} is not authorized`,
          { outcome: authz.outcome },
        );
      }

      await this.verifyBindingFreshness(request);

      if (decision.decision === "REQUEST_MODIFICATION") {
        const note = decision.note?.trim();
        if (!note) {
          throw new AuthorizationError(
            "MODIFICATION_REQUEST_INVALID",
            "modificationNote is required for REQUEST_MODIFICATION",
          );
        }
      }

      const record = parseAuthorizationRecord({
        authorizationRecordId: this.identities.nextAuthorizationRecordId(),
        approvalRequestId: request.approvalRequestId,
        runId: request.runId,
        projectId: request.projectId,
        objectiveId: request.objectiveId,
        objectiveVersion: request.objectiveVersion,
        planId: request.planId,
        planVersion: request.planVersion,
        planHash: request.planHash,
        repositoryFingerprint: request.repositoryFingerprint,
        policyBundleHash: request.policyBundleHash,
        validationDecisionId: request.validationDecisionId,
        approverId: decision.approverId,
        decision: decision.decision,
        decisionTimestamp: decision.submittedAt,
        decisionCardHash: request.decisionCardHash,
        capabilitySetFingerprint: request.capabilitySetFingerprint,
        nonceHash,
        createdAt: now,
        ...(decision.note !== undefined ? { note: decision.note } : {}),
      });
      return await withOptionalTransaction(this.deps.transactions, async () => {
        await this.deps.records.append(record);

        if (decision.decision === "APPROVE") {
          await this.deps.requests.updateStatus(
            request.approvalRequestId,
            "APPROVED",
          );
          const next = assertTransition(run.state, "APPROVED");
          await commitRunTransition(this.deps.runs, run, next, now);
          await this.deps.coordinator.completeDecision(request.approvalRequestId);
          return {
            runId: request.runId,
            approvalRequestId: request.approvalRequestId,
            planId: request.planId,
            planVersion: request.planVersion,
            planHash: request.planHash,
            result: "APPROVED" as const,
            authorizationRecordId: record.authorizationRecordId,
            requiresFurtherAction: false,
            runState: "APPROVED" as const,
          };
        }

        if (decision.decision === "REJECT") {
          await this.deps.requests.updateStatus(
            request.approvalRequestId,
            "REJECTED",
          );
          const next = assertTransition(run.state, "REJECTED");
          await commitRunTransition(this.deps.runs, run, next, now);
          await this.deps.coordinator.completeDecision(request.approvalRequestId);
          return {
            runId: request.runId,
            approvalRequestId: request.approvalRequestId,
            planId: request.planId,
            planVersion: request.planVersion,
            planHash: request.planHash,
            result: "REJECTED" as const,
            authorizationRecordId: record.authorizationRecordId,
            requiresFurtherAction: true,
            runState: "REJECTED" as const,
          };
        }

        const modification = parseModificationRequest({
          modificationRequestId: this.identities.nextModificationRequestId(),
          runId: request.runId,
          approvalRequestId: request.approvalRequestId,
          sourcePlanId: request.planId,
          sourcePlanVersion: request.planVersion,
          requestedBy: decision.approverId,
          requestedAt: decision.submittedAt,
          modificationNote: decision.note!.trim(),
        });
        await this.deps.modifications.save(modification);
        await this.deps.requests.updateStatus(
          request.approvalRequestId,
          "MODIFICATION_REQUESTED",
        );
        const next = assertTransition(run.state, "ESCALATED");
        await commitRunTransition(
          this.deps.runs,
          run,
          next,
          now,
          { failureReasonCode: "MODIFICATION_REQUESTED" },
        );
        await this.deps.coordinator.completeDecision(request.approvalRequestId);
        return {
          runId: request.runId,
          approvalRequestId: request.approvalRequestId,
          planId: request.planId,
          planVersion: request.planVersion,
          planHash: request.planHash,
          result: "MODIFICATION_REQUESTED" as const,
          authorizationRecordId: record.authorizationRecordId,
          requiresFurtherAction: true,
          runState: "ESCALATED" as const,
          modificationRequestId: modification.modificationRequestId,
        };
      });
    } catch (error) {
      await this.deps.coordinator.failDecision(request.approvalRequestId);
      throw error;
    }
  }

  async getPendingRequest(runId: string): Promise<ApprovalRequest | null> {
    return this.deps.requests.getPendingByRun(runId);
  }

  /**
   * Replace an unusable ApprovalRequest while the run remains AWAITING_APPROVAL.
   *
   * Used after a burned nonce (e.g. UNKNOWN_APPROVER) leaves PENDING A unusable.
   * Does not call AuthorizationRoutingService.route() and does not regress run state.
   */
  async reissueApprovalRequest(input: {
    runId: string;
    replacedApprovalRequestId: string;
  }): Promise<ApprovalReissueResult> {
    const run = await this.deps.runs.getById(input.runId);
    if (!run || run.state !== "AWAITING_APPROVAL") {
      throw new AuthorizationError(
        "INVALID_AUTHORIZATION_STATE",
        "Approval reissue requires run state AWAITING_APPROVAL",
        { runId: input.runId, state: run?.state },
      );
    }

    const replaced = await this.deps.requests.getById(
      input.replacedApprovalRequestId,
    );
    if (!replaced) {
      throw new AuthorizationError(
        "APPROVAL_REQUEST_NOT_FOUND",
        `Unknown approval request: ${input.replacedApprovalRequestId}`,
      );
    }
    if (replaced.runId !== input.runId) {
      throw new AuthorizationError(
        "AUTHORIZATION_BINDING_MISMATCH",
        "Replaced approval request does not belong to this run",
        {
          runId: input.runId,
          replacedApprovalRequestId: input.replacedApprovalRequestId,
        },
      );
    }

    const existingLive = await this.findLiveReplacement(
      input.runId,
      replaced.approvalRequestId,
    );
    if (existingLive) {
      return this.toReissueResult(existingLive, replaced.approvalRequestId);
    }

    const nonceConsumed = await this.deps.coordinator.isNonceConsumed(
      replaced.approvalRequestId,
    );
    const eligibleTerminal =
      replaced.status === "CANCELLED" || replaced.status === "SUPERSEDED";
    if (replaced.status === "PENDING") {
      if (!nonceConsumed) {
        throw new AuthorizationError(
          "APPROVAL_REISSUE_NOT_ELIGIBLE",
          "Pending approval request still has a usable nonce; reissue not required",
          { approvalRequestId: replaced.approvalRequestId },
        );
      }
    } else if (!eligibleTerminal) {
      throw new AuthorizationError(
        "APPROVAL_REISSUE_NOT_ELIGIBLE",
        `Cannot reissue from approval request status ${replaced.status}`,
        {
          approvalRequestId: replaced.approvalRequestId,
          status: replaced.status,
        },
      );
    }

    const claim = await this.deps.coordinator.beginReissue(
      replaced.approvalRequestId,
    );
    if (claim.outcome === "ALREADY") {
      const already = await this.deps.requests.getById(claim.approvalRequestId);
      if (already && already.status === "PENDING") {
        return this.toReissueResult(already, replaced.approvalRequestId);
      }
      const afterWait = await this.findLiveReplacement(
        input.runId,
        replaced.approvalRequestId,
      );
      if (afterWait) {
        return this.toReissueResult(afterWait, replaced.approvalRequestId);
      }
      throw new AuthorizationError(
        "APPROVAL_REISSUE_NOT_ELIGIBLE",
        "Concurrent reissue completed without a live replacement",
        { replacedApprovalRequestId: replaced.approvalRequestId },
      );
    }

    try {
      if (replaced.status === "PENDING") {
        await this.deps.requests.updateStatus(
          replaced.approvalRequestId,
          "CANCELLED",
          { failureReasonCode: "APPROVAL_NONCE_CONSUMED" },
        );
        await this.deps.coordinator.invalidateNonce(replaced.approvalRequestId);
      }

      const afterCancel = await this.findLiveReplacement(
        input.runId,
        replaced.approvalRequestId,
      );
      if (afterCancel) {
        await this.deps.coordinator.completeReissue(
          replaced.approvalRequestId,
          afterCancel.approvalRequestId,
        );
        return this.toReissueResult(afterCancel, replaced.approvalRequestId);
      }

      const live = await this.deps.requests.getPendingByRun(input.runId);
      if (live) {
        if (live.replacesApprovalRequestId === replaced.approvalRequestId) {
          await this.deps.coordinator.completeReissue(
            replaced.approvalRequestId,
            live.approvalRequestId,
          );
          return this.toReissueResult(live, replaced.approvalRequestId);
        }
        throw new AuthorizationError(
          "APPROVAL_REQUEST_ALREADY_EXISTS",
          "A different PENDING approval request already exists for this run",
          { approvalRequestId: live.approvalRequestId },
        );
      }

      const created = await this.createReplacementRequest(run, replaced);
      await this.deps.coordinator.completeReissue(
        replaced.approvalRequestId,
        created.approvalRequestId,
      );
      return this.toReissueResult(created, replaced.approvalRequestId);
    } catch (error) {
      await this.deps.coordinator.failReissue(replaced.approvalRequestId);
      throw error;
    }
  }

  private async findLiveReplacement(
    runId: string,
    replacedApprovalRequestId: string,
  ): Promise<ApprovalRequest | null> {
    const mappedId = await this.deps.coordinator.getReissueReplacementId(
      replacedApprovalRequestId,
    );
    if (mappedId) {
      const mapped = await this.deps.requests.getById(mappedId);
      if (mapped && mapped.status === "PENDING") {
        return mapped;
      }
    }
    const history = await this.deps.requests.listByRun(runId);
    return (
      history.find(
        (request) =>
          request.status === "PENDING" &&
          request.replacesApprovalRequestId === replacedApprovalRequestId,
      ) ?? null
    );
  }

  private toReissueResult(
    request: ApprovalRequest,
    replacedApprovalRequestId: string,
  ): ApprovalReissueResult {
    return {
      runId: request.runId,
      replacedApprovalRequestId,
      approvalRequestId: request.approvalRequestId,
      decisionCardHash: request.decisionCardHash,
      planId: request.planId,
      planVersion: request.planVersion,
      planHash: request.planHash,
      runState: "AWAITING_APPROVAL",
      replacesApprovalRequestId: replacedApprovalRequestId,
    };
  }

  private async createReplacementRequest(
    run: NonNullable<Awaited<ReturnType<RunRepository["getById"]>>>,
    replaced: ApprovalRequest,
  ): Promise<ApprovalRequest> {
    const objective = await this.deps.objectives.getByRunBinding(run.runId);
    if (!objective) {
      throw new AuthorizationError(
        "AUTHORIZATION_BINDING_MISMATCH",
        "Objective missing for approval reissue",
      );
    }
    const plan = await this.deps.plans.getById(replaced.planId);
    if (!plan) {
      throw new AuthorizationError(
        "PLAN_SUPERSEDED",
        "Bound plan missing for approval reissue",
      );
    }
    if (
      plan.planVersion !== replaced.planVersion ||
      plan.planHash !== replaced.planHash
    ) {
      throw new AuthorizationError(
        "AUTHORIZATION_BINDING_MISMATCH",
        "Plan identity diverged from replaced approval request",
      );
    }
    const decision = await this.deps.decisions.getByPlan(
      run.runId,
      replaced.planId,
      replaced.planVersion,
    );
    if (
      !decision ||
      decision.validationDecisionId !== replaced.validationDecisionId
    ) {
      throw new AuthorizationError(
        "AUTHORIZATION_BINDING_MISMATCH",
        "Validation decision diverged from replaced approval request",
      );
    }

    const resolved = await this.deps.controlPlane.resolve(
      run.projectId,
      run.requestedEnvironment,
    );
    const now = this.deps.clock.nowIso();
    const expiresAt = addMsIso(now, this.approvalWindowMs);
    const card = buildApprovalDecisionCard({
      objective,
      plan: plan.plan,
      decision,
      whyApprovalRequired: whyApprovalRequiredForDecision(decision),
      createdAt: now,
      expiresAt,
      availableCapabilities: resolved.availableCapabilities,
    });
    const decisionCardHash = this.cardHasher.hash(card);
    const bindingKey = approvalBindingKey({
      runId: run.runId,
      planId: plan.planId,
      planVersion: plan.planVersion,
      planHash: plan.planHash,
      validationDecisionId: decision.validationDecisionId,
      decisionCardHash,
    });

    await this.deps.coordinator.supersedePendingForRun(
      run.runId,
      null,
      "APPROVAL_REISSUED",
    );

    const issued = issueDecisionNonce(this.nonceGenerator);
    const request = parseApprovalRequest({
      approvalRequestId: this.identities.nextApprovalRequestId(),
      runId: run.runId,
      projectId: run.projectId,
      objectiveId: objective.objectiveId,
      objectiveVersion: objective.objectiveVersion,
      planId: plan.planId,
      planVersion: plan.planVersion,
      planHash: plan.planHash,
      repositoryCommitSha: replaced.repositoryCommitSha,
      repositoryFingerprint: replaced.repositoryFingerprint,
      policyBundleId: replaced.policyBundleId,
      policyBundleHash: replaced.policyBundleHash,
      validationDecisionId: decision.validationDecisionId,
      validationDecision: decision.decision,
      requestReason: replaced.requestReason,
      requestedApproverIds: [...resolved.project.authorizedApproverIds],
      createdAt: now,
      expiresAt,
      status: "PENDING",
      decisionCardHash,
      capabilitySetFingerprint: card.capabilitySetFingerprint,
      decisionNonceHash: issued.nonceHash,
      replacesApprovalRequestId: replaced.approvalRequestId,
    });

    await this.deps.requests.save(request);
    await this.deps.cards.save(request.approvalRequestId, card);

    try {
      await this.deps.delivery.deliverApprovalRequest({
        request,
        card,
        decisionNonce: issued.plaintext,
      });
    } catch (error) {
      await this.deps.requests.updateStatus(
        request.approvalRequestId,
        "CANCELLED",
        {
          deliveryFailedAt: this.deps.clock.nowIso(),
          deliveryFailureCode: "APPROVAL_DELIVERY_FAILED",
          failureReasonCode: "APPROVAL_DELIVERY_FAILED",
        },
      );
      await this.deps.coordinator.invalidateNonce(request.approvalRequestId);
      if (error instanceof AuthorizationError) {
        throw error;
      }
      throw new AuthorizationError(
        "APPROVAL_DELIVERY_FAILED",
        error instanceof Error ? error.message : "Delivery failed",
        { approvalRequestId: request.approvalRequestId },
      );
    }

    await this.deps.coordinator.registerPending(request, bindingKey);

    const refreshed = await this.deps.runs.getById(run.runId);
    if (!refreshed || refreshed.state !== "AWAITING_APPROVAL") {
      throw new AuthorizationError(
        "INVALID_AUTHORIZATION_STATE",
        "Run left AWAITING_APPROVAL during approval reissue",
        { runId: run.runId, state: refreshed?.state },
      );
    }

    return request;
  }

  async getLatestAuthorization(runId: string) {
    return this.deps.records.getLatestByRun(runId);
  }

  private async verifyBindingFreshness(
    request: ApprovalRequest,
  ): Promise<void> {
    const plan = await this.deps.plans.getById(request.planId);
    if (!plan || plan.status === "SUPERSEDED") {
      throw new AuthorizationError(
        "PLAN_SUPERSEDED",
        "Bound plan is missing or superseded",
        { planId: request.planId },
      );
    }
    if (
      plan.planVersion !== request.planVersion ||
      plan.planHash !== request.planHash
    ) {
      throw new AuthorizationError(
        "AUTHORIZATION_BINDING_MISMATCH",
        "Stored plan identity does not match approval binding",
      );
    }

    const recomputed = this.planHasher.hash(plan.plan);
    if (recomputed !== request.planHash || recomputed !== plan.plan.planHash) {
      throw new AuthorizationError(
        "AUTHORIZATION_BINDING_STALE",
        "Plan hash no longer matches the approved candidate",
      );
    }

    const latest = await this.deps.plans.getByRunId(request.runId);
    if (
      latest &&
      (latest.planId !== request.planId ||
        latest.planVersion !== request.planVersion)
    ) {
      throw new AuthorizationError(
        "PLAN_SUPERSEDED",
        "A newer plan version supersedes this approval request",
      );
    }

    const lock = await this.deps.locks.getByRunId(request.runId);
    if (!lock || lock.status === "INVALID") {
      throw new AuthorizationError(
        "REPOSITORY_CHANGED_DURING_APPROVAL",
        "Repository lock is missing or INVALID",
      );
    }
    if (lock.status === "STALE") {
      throw new AuthorizationError(
        "AUTHORIZATION_BINDING_STALE",
        "Repository became STALE while awaiting approval",
      );
    }
    if (lock.commitSha !== request.repositoryCommitSha) {
      throw new AuthorizationError(
        "REPOSITORY_CHANGED_DURING_APPROVAL",
        "Repository commit SHA changed during approval",
      );
    }

    const run = await this.deps.runs.getById(request.runId);
    if (!run) {
      throw new AuthorizationError(
        "AUTHORIZATION_BINDING_MISMATCH",
        "Run missing during approval",
      );
    }
    const resolved = await this.deps.controlPlane.resolve(
      run.projectId,
      run.requestedEnvironment,
    );
    if (resolved.activePolicyBundle.policyHash !== request.policyBundleHash) {
      throw new AuthorizationError(
        "POLICY_CHANGED_DURING_APPROVAL",
        "Active policy bundle hash changed during approval",
      );
    }

    const liveCaps = uniqueCapabilitiesForPlanActions({
      stepActionTypes: plan.plan.steps.map((s) => s.actionType),
      availableCapabilities: resolved.availableCapabilities,
    });
    for (const step of plan.plan.steps) {
      const permitted = resolved.availableCapabilities.some((c) =>
        c.allowedActions.includes(step.actionType),
      );
      if (!permitted) {
        throw new AuthorizationError(
          "CAPABILITY_CHANGED_DURING_APPROVAL",
          `Capability for ${step.actionType} unavailable during approval`,
        );
      }
    }
    const liveCapabilityFingerprint = capabilitySetFingerprint(liveCaps);
    if (liveCapabilityFingerprint !== request.capabilitySetFingerprint) {
      throw new AuthorizationError(
        "CAPABILITY_CHANGED_DURING_APPROVAL",
        "Capability set fingerprint changed during approval review",
        {
          expected: request.capabilitySetFingerprint,
          live: liveCapabilityFingerprint,
        },
      );
    }

    const validation = await this.deps.decisions.getById(
      request.validationDecisionId,
    );
    if (
      !validation ||
      validation.planHash !== request.planHash ||
      validation.validationDecisionId !== request.validationDecisionId
    ) {
      throw new AuthorizationError(
        "AUTHORIZATION_BINDING_MISMATCH",
        "Validation decision binding no longer matches",
      );
    }

    const objective = await this.deps.objectives.getByRunBinding(request.runId);
    if (
      !objective ||
      objective.objectiveId !== request.objectiveId ||
      objective.objectiveVersion !== request.objectiveVersion
    ) {
      throw new AuthorizationError(
        "AUTHORIZATION_BINDING_MISMATCH",
        "Objective binding no longer matches",
      );
    }

    const storedCard = await this.deps.cards.get(request.approvalRequestId);
    if (!storedCard) {
      throw new AuthorizationError(
        "DECISION_CARD_HASH_MISMATCH",
        "Decision card missing for approval request",
      );
    }
    if (this.cardHasher.hash(storedCard) !== request.decisionCardHash) {
      throw new AuthorizationError(
        "DECISION_CARD_HASH_MISMATCH",
        "Stored decision card does not match decisionCardHash",
      );
    }
    if (
      storedCard.planHash !== request.planHash ||
      storedCard.planVersion !== request.planVersion ||
      storedCard.validationDecisionId !== request.validationDecisionId ||
      storedCard.policyBundleHash !== request.policyBundleHash ||
      storedCard.repositoryFingerprint !== request.repositoryFingerprint ||
      storedCard.capabilitySetFingerprint !== request.capabilitySetFingerprint
    ) {
      throw new AuthorizationError(
        "AUTHORIZATION_BINDING_STALE",
        "Decision card binding fields no longer match the approval request",
      );
    }
  }
}
