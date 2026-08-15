import type { ClockPort } from "../infrastructure/clock.js";
import type { RunRepository } from "../admission/run-repository.js";
import { withRunState } from "../admission/run-repository.js";
import type { ObjectiveRepository } from "../admission/objective-repository.js";
import type { ControlPlaneService } from "../control-plane/service.js";
import type { PlanRepository, StoredPlanRecord } from "../planning/plan-repository.js";
import type { ValidationDecisionRepository } from "../validation/decision-repository.js";
import type { LockedRepositoryStore } from "../ingestion/locked-state.js";
import {
  approvalBindingKey,
  parseApprovalRequest,
  type ApprovalRequest,
  type ApprovalRequestReason,
} from "../domain/authorization/index.js";
import { assertTransition } from "../domain/run/run-state.js";
import type { ValidationDecision } from "../domain/validation/index.js";
import type { PlanningException } from "../validation/exception.js";
import type { AuthorizationReadinessService } from "./readiness.js";
import type { ApprovalRequestRepository } from "./approval-request-repository.js";
import type { AuthorizationCoordinator } from "./coordinator.js";
import type { ApprovalDeliveryService } from "./delivery.js";
import type { DecisionCardStore } from "./decision-card-store.js";
import {
  Sha256DecisionCardHasher,
  type DecisionCardHasher,
} from "./decision-card-hasher.js";
import {
  buildApprovalDecisionCard,
  whyApprovalRequiredForDecision,
} from "./decision-card-builder.js";
import {
  addMsIso,
  DEFAULT_APPROVAL_WINDOW_MS,
  SequenceAuthorizationIdentityGenerator,
  type AuthorizationIdentityGenerator,
} from "./identity.js";
import {
  CryptoDecisionNonceGenerator,
  issueDecisionNonce,
  type DecisionNonceGenerator,
} from "./decision-nonce.js";
import { AuthorizationError } from "./errors.js";
import type { AuthorizationRoutingOutcome } from "./result.js";

export interface AuthorizationRoutingServiceDeps {
  readiness: AuthorizationReadinessService;
  runs: RunRepository;
  objectives: ObjectiveRepository;
  controlPlane: ControlPlaneService;
  plans: PlanRepository;
  decisions: ValidationDecisionRepository;
  locks: LockedRepositoryStore;
  requests: ApprovalRequestRepository;
  cards: DecisionCardStore;
  coordinator: AuthorizationCoordinator;
  delivery: ApprovalDeliveryService;
  clock: ClockPort;
  identities?: AuthorizationIdentityGenerator;
  nonceGenerator?: DecisionNonceGenerator;
  cardHasher?: DecisionCardHasher;
  approvalWindowMs?: number;
  resolvePlanningException?: (
    runId: string,
    validationDecisionId: string,
  ) => Promise<PlanningException | undefined>;
}

/**
 * Consumes terminal Phase 5 ValidationDecisions and routes authorization.
 *
 * PASS != APPROVED: PASS still creates an ApprovalRequest.
 * BLOCK → BLOCKED with no approval request.
 *
 * Preferred sequence: persist → deliver → transition AWAITING_APPROVAL.
 * Delivery failure cancels that request permanently; retry creates a new
 * ApprovalRequest with fresh id, nonce, expiry, and decisionCardHash.
 */
export class AuthorizationRoutingService {
  private readonly identities: AuthorizationIdentityGenerator;
  private readonly nonceGenerator: DecisionNonceGenerator;
  private readonly cardHasher: DecisionCardHasher;
  private readonly approvalWindowMs: number;

  constructor(private readonly deps: AuthorizationRoutingServiceDeps) {
    this.identities =
      deps.identities ?? new SequenceAuthorizationIdentityGenerator();
    this.nonceGenerator =
      deps.nonceGenerator ?? new CryptoDecisionNonceGenerator();
    this.cardHasher = deps.cardHasher ?? new Sha256DecisionCardHasher();
    this.approvalWindowMs =
      deps.approvalWindowMs ?? DEFAULT_APPROVAL_WINDOW_MS;
  }

  async route(runId: string): Promise<AuthorizationRoutingOutcome> {
    const existingRun = await this.deps.runs.getById(runId);
    if (existingRun?.state === "AWAITING_APPROVAL") {
      const pending = await this.deps.requests.getPendingByRun(runId);
      if (pending) {
        return {
          outcome: "ALREADY_ROUTED",
          runId,
          planId: pending.planId,
          planVersion: pending.planVersion,
          planHash: pending.planHash,
          validationDecisionId: pending.validationDecisionId,
          approvalRequestId: pending.approvalRequestId,
          runState: "AWAITING_APPROVAL",
        };
      }
    }
    if (existingRun?.state === "BLOCKED") {
      const decision = await this.deps.decisions.getLatestByRunId(runId);
      const plan = await this.deps.plans.getByRunId(runId);
      return {
        outcome: "ALREADY_ROUTED",
        runId,
        planId: plan?.planId ?? decision?.planId ?? "unknown",
        planVersion: plan?.planVersion ?? decision?.planVersion ?? 1,
        planHash: plan?.planHash ?? decision?.planHash ?? "unknown",
        validationDecisionId: decision?.validationDecisionId ?? "unknown",
        runState: "BLOCKED",
      };
    }

    const { plan, decision } = await this.deps.readiness.requireReady(runId);

    if (decision.decision === "BLOCK") {
      return this.routeBlock(
        runId,
        plan.planId,
        plan.planVersion,
        plan.planHash,
        decision,
      );
    }

    if (
      decision.decision === "PASS" ||
      decision.decision === "HUMAN_APPROVAL_REQUIRED"
    ) {
      return this.routeForApproval(runId, plan, decision);
    }

    throw new AuthorizationError(
      "AUTHORIZATION_DECISION_NOT_TERMINAL",
      `Cannot route authorization for decision ${decision.decision}`,
    );
  }

  private async routeBlock(
    runId: string,
    planId: string,
    planVersion: number,
    planHash: string,
    decision: ValidationDecision,
  ): Promise<AuthorizationRoutingOutcome> {
    const run = await this.deps.runs.getById(runId);
    if (!run) {
      throw new AuthorizationError(
        "AUTHORIZATION_NOT_READY",
        `Run not found: ${runId}`,
      );
    }
    if (run.state === "BLOCKED") {
      return {
        outcome: "ALREADY_ROUTED",
        runId,
        planId,
        planVersion,
        planHash,
        validationDecisionId: decision.validationDecisionId,
        runState: "BLOCKED",
      };
    }
    const next = assertTransition(run.state, "BLOCKED");
    await this.deps.runs.save(
      withRunState(run, next, this.deps.clock.nowIso(), {
        failureReasonCode: "VALIDATION_BLOCK",
      }),
    );
    return {
      outcome: "BLOCKED",
      runId,
      planId,
      planVersion,
      planHash,
      validationDecisionId: decision.validationDecisionId,
      runState: "BLOCKED",
    };
  }

  private async routeForApproval(
    runId: string,
    plan: StoredPlanRecord,
    decision: ValidationDecision,
  ): Promise<AuthorizationRoutingOutcome> {
    const run = await this.deps.runs.getById(runId);
    if (!run) {
      throw new AuthorizationError(
        "AUTHORIZATION_NOT_READY",
        `Run not found: ${runId}`,
      );
    }
    const objective = await this.deps.objectives.getByRunBinding(runId);
    if (!objective) {
      throw new AuthorizationError(
        "AUTHORIZATION_NOT_READY",
        "Objective missing for authorization routing",
      );
    }
    const resolved = await this.deps.controlPlane.resolve(
      run.projectId,
      run.requestedEnvironment,
    );

    const now = this.deps.clock.nowIso();
    const expiresAt = addMsIso(now, this.approvalWindowMs);
    const exception = this.deps.resolvePlanningException
      ? await this.deps.resolvePlanningException(
          runId,
          decision.validationDecisionId,
        )
      : undefined;

    const card = buildApprovalDecisionCard({
      objective,
      plan: plan.plan,
      decision,
      whyApprovalRequired: whyApprovalRequiredForDecision(decision),
      createdAt: now,
      expiresAt,
      ...(exception ? { planningException: exception } : {}),
    });
    const decisionCardHash = this.cardHasher.hash(card);
    const bindingKey = approvalBindingKey({
      runId,
      planId: plan.planId,
      planVersion: plan.planVersion,
      planHash: plan.planHash,
      validationDecisionId: decision.validationDecisionId,
      decisionCardHash,
    });

    const existingPending =
      await this.deps.coordinator.findActiveByBinding(bindingKey);
    if (existingPending) {
      if (run.state === "AWAITING_APPROVAL") {
        return {
          outcome: "ALREADY_ROUTED",
          runId,
          planId: plan.planId,
          planVersion: plan.planVersion,
          planHash: plan.planHash,
          validationDecisionId: decision.validationDecisionId,
          approvalRequestId: existingPending.approvalRequestId,
          runState: "AWAITING_APPROVAL",
        };
      }
      // PENDING without AWAITING_APPROVAL is inconsistent; fail closed.
      throw new AuthorizationError(
        "INVALID_AUTHORIZATION_STATE",
        "PENDING approval request exists while run is not AWAITING_APPROVAL",
        {
          approvalRequestId: existingPending.approvalRequestId,
          runState: run.state,
        },
      );
    }

    // Audit lineage only: prior delivery-failed cancel for same plan identity.
    const history = await this.deps.requests.listByRun(runId);
    const priorCancelled = [...history]
      .reverse()
      .find(
        (request) =>
          request.status === "CANCELLED" &&
          request.deliveryFailureCode === "APPROVAL_DELIVERY_FAILED" &&
          request.planId === plan.planId &&
          request.planVersion === plan.planVersion &&
          request.planHash === plan.planHash &&
          request.validationDecisionId === decision.validationDecisionId,
      );

    await this.deps.coordinator.supersedePendingForRun(
      runId,
      null,
      "PLAN_SUPERSEDED",
    );

    const issued = issueDecisionNonce(this.nonceGenerator);
    const request = parseApprovalRequest({
      approvalRequestId: this.identities.nextApprovalRequestId(),
      runId,
      projectId: run.projectId,
      objectiveId: objective.objectiveId,
      objectiveVersion: objective.objectiveVersion,
      planId: plan.planId,
      planVersion: plan.planVersion,
      planHash: plan.planHash,
      repositoryCommitSha: plan.plan.repositoryCommitSha,
      repositoryFingerprint: plan.plan.repositoryFingerprint,
      policyBundleId: plan.plan.policyBundleId,
      policyBundleHash: plan.plan.policyBundleHash,
      validationDecisionId: decision.validationDecisionId,
      validationDecision: decision.decision,
      requestReason: requestReasonFor(decision),
      requestedApproverIds: [...resolved.project.authorizedApproverIds],
      createdAt: now,
      expiresAt,
      status: "PENDING",
      decisionCardHash,
      decisionNonceHash: issued.nonceHash,
      ...(priorCancelled
        ? { replacesApprovalRequestId: priorCancelled.approvalRequestId }
        : {}),
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

    if (run.state !== "AWAITING_APPROVAL") {
      const next = assertTransition(run.state, "AWAITING_APPROVAL");
      await this.deps.runs.save(
        withRunState(run, next, this.deps.clock.nowIso()),
      );
    }

    return {
      outcome: "PENDING_APPROVAL",
      runId,
      planId: plan.planId,
      planVersion: plan.planVersion,
      planHash: plan.planHash,
      validationDecisionId: decision.validationDecisionId,
      approvalRequestId: request.approvalRequestId,
      decisionCardHash: request.decisionCardHash,
      runState: "AWAITING_APPROVAL",
      ...(priorCancelled
        ? { replacesApprovalRequestId: priorCancelled.approvalRequestId }
        : {}),
    };
  }
}

function requestReasonFor(
  decision: ValidationDecision,
): ApprovalRequestReason {
  if (decision.decision === "PASS") {
    return "EXECUTION_AUTHORIZATION";
  }
  const hasPolicy = decision.findings.some(
    (finding) =>
      finding.ruleId === "REQUIRE_APPROVAL" || finding.category === "policy",
  );
  if (hasPolicy) {
    return "POLICY_REQUIRE_APPROVAL";
  }
  return "HUMAN_APPROVAL_REQUIRED";
}
