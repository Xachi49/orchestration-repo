import type { ClockPort } from "../infrastructure/clock.js";
import type { RunRepository } from "../admission/run-repository.js";
import { withRunState } from "../admission/run-repository.js";
import type { ObjectiveRepository } from "../admission/objective-repository.js";
import type { ControlPlaneService } from "../control-plane/service.js";
import type { PlanRepository } from "../planning/plan-repository.js";
import type { ValidationDecisionRepository } from "../validation/decision-repository.js";
import type { LockedRepositoryStore } from "../ingestion/locked-state.js";
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
import {
  Sha256DecisionCardHasher,
  type DecisionCardHasher,
} from "./decision-card-hasher.js";
import {
  isExpired,
  SequenceAuthorizationIdentityGenerator,
  type AuthorizationIdentityGenerator,
} from "./identity.js";
import { AuthorizationError } from "./errors.js";
import type { AuthorizationResult } from "./result.js";

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
  identities?: AuthorizationIdentityGenerator;
  cardHasher?: DecisionCardHasher;
  planHasher?: Sha256PlanHasher;
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

  constructor(private readonly deps: HumanAuthorizationServiceDeps) {
    this.identities =
      deps.identities ?? new SequenceAuthorizationIdentityGenerator();
    this.cardHasher = deps.cardHasher ?? new Sha256DecisionCardHasher();
    this.planHasher = deps.planHasher ?? new Sha256PlanHasher();
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
        await this.deps.runs.save(withRunState(run, next, now));
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
        nonceHash,
        createdAt: now,
        ...(decision.note !== undefined ? { note: decision.note } : {}),
      });
      await this.deps.records.append(record);

      if (decision.decision === "APPROVE") {
        await this.deps.requests.updateStatus(
          request.approvalRequestId,
          "APPROVED",
        );
        const next = assertTransition(run.state, "APPROVED");
        await this.deps.runs.save(withRunState(run, next, now));
        await this.deps.coordinator.completeDecision(request.approvalRequestId);
        return {
          runId: request.runId,
          approvalRequestId: request.approvalRequestId,
          planId: request.planId,
          planVersion: request.planVersion,
          planHash: request.planHash,
          result: "APPROVED",
          authorizationRecordId: record.authorizationRecordId,
          requiresFurtherAction: false,
          runState: "APPROVED",
        };
      }

      if (decision.decision === "REJECT") {
        await this.deps.requests.updateStatus(
          request.approvalRequestId,
          "REJECTED",
        );
        const next = assertTransition(run.state, "REJECTED");
        await this.deps.runs.save(withRunState(run, next, now));
        await this.deps.coordinator.completeDecision(request.approvalRequestId);
        return {
          runId: request.runId,
          approvalRequestId: request.approvalRequestId,
          planId: request.planId,
          planVersion: request.planVersion,
          planHash: request.planHash,
          result: "REJECTED",
          authorizationRecordId: record.authorizationRecordId,
          requiresFurtherAction: true,
          runState: "REJECTED",
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
      await this.deps.runs.save(
        withRunState(run, next, now, {
          failureReasonCode: "MODIFICATION_REQUESTED",
        }),
      );
      await this.deps.coordinator.completeDecision(request.approvalRequestId);
      return {
        runId: request.runId,
        approvalRequestId: request.approvalRequestId,
        planId: request.planId,
        planVersion: request.planVersion,
        planHash: request.planHash,
        result: "MODIFICATION_REQUESTED",
        authorizationRecordId: record.authorizationRecordId,
        requiresFurtherAction: true,
        runState: "ESCALATED",
        modificationRequestId: modification.modificationRequestId,
      };
    } catch (error) {
      await this.deps.coordinator.failDecision(request.approvalRequestId);
      throw error;
    }
  }

  async getPendingRequest(runId: string): Promise<ApprovalRequest | null> {
    return this.deps.requests.getPendingByRun(runId);
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
      storedCard.repositoryFingerprint !== request.repositoryFingerprint
    ) {
      throw new AuthorizationError(
        "AUTHORIZATION_BINDING_STALE",
        "Decision card binding fields no longer match the approval request",
      );
    }
  }
}
