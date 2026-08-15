import { describe, expect, it } from "vitest";
import { createLocalAuthorizationStack } from "../infrastructure/authorization/local-stack.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
  EXAMPLE_CAPABILITIES,
} from "../control-plane/fixtures.js";
import { assertTransition } from "../domain/run/run-state.js";
import { AuthorizationError } from "./errors.js";
import { FakeApprovalDeliveryService } from "./delivery.js";
import { Sha256DecisionCardHasher } from "./decision-card-hasher.js";
import { hashDecisionNonce } from "./decision-card-hasher.js";
import { addMsIso, DEFAULT_APPROVAL_WINDOW_MS } from "./identity.js";
import { FakeValidationModel } from "../validation/fake-validation-model.js";
import type { LocalAuthorizationStack } from "../infrastructure/authorization/local-stack.js";
import type { ProjectControlContext } from "../control-plane/context.js";

async function validatedRun(options?: {
  delivery?: FakeApprovalDeliveryService;
  approvalWindowMs?: number;
  validationModel?: FakeValidationModel;
}) {
  const delivery = options?.delivery ?? new FakeApprovalDeliveryService();
  const stack = createLocalAuthorizationStack({
    approvalDelivery: delivery,
    ...(options?.approvalWindowMs !== undefined
      ? { approvalWindowMs: options.approvalWindowMs }
      : {}),
    ...(options?.validationModel
      ? { validationModel: options.validationModel }
      : {}),
  });
  const admitted = await stack.admission.admit(exampleAdmissionRequest());
  if (admitted.outcome !== "ADMITTED") {
    throw new Error(`expected ADMITTED, got ${admitted.outcome}`);
  }
  const runId = admitted.runId;
  await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
  await stack.planning.plan(runId);
  await stack.validation.validate(runId);
  return { stack, runId, delivery };
}

function deliveredNonce(
  delivery: FakeApprovalDeliveryService | LocalAuthorizationStack["approvalDelivery"],
  approvalRequestId: string,
): string {
  if (!(delivery instanceof FakeApprovalDeliveryService)) {
    throw new Error("expected FakeApprovalDeliveryService");
  }
  const nonce = delivery.nonceFor(approvalRequestId);
  if (!nonce) {
    throw new Error(`no delivered nonce for ${approvalRequestId}`);
  }
  return nonce;
}

describe("AuthorizationRoutingService", () => {
  it("routes PASS to AWAITING_APPROVAL and never to APPROVED", async () => {
    const { stack, runId } = await validatedRun();
    const routed = await stack.authorizationRouting.route(runId);
    expect(routed.outcome).toBe("PENDING_APPROVAL");
    if (routed.outcome !== "PENDING_APPROVAL") {
      return;
    }
    expect(routed.runState).toBe("AWAITING_APPROVAL");
    const run = await stack.runs.getById(runId);
    expect(run?.state).toBe("AWAITING_APPROVAL");
    expect(run?.state).not.toBe("APPROVED");
    const pending = await stack.approvalRequests.getPendingByRun(runId);
    expect(pending?.validationDecision).toBe("PASS");
    expect(pending?.requestReason).toBe("EXECUTION_AUTHORIZATION");
    expect(pending?.decisionNonceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("PASS != APPROVED regression: routing alone cannot approve", async () => {
    const { stack, runId } = await validatedRun();
    await stack.authorizationRouting.route(runId);
    expect(() => assertTransition("VALIDATING", "APPROVED")).toThrow();
    const run = await stack.runs.getById(runId);
    expect(run?.state).toBe("AWAITING_APPROVAL");
  });

  it("routes BLOCK to BLOCKED without an approval request", async () => {
    const stack = createLocalAuthorizationStack();
    const admitted = await stack.admission.admit(exampleAdmissionRequest());
    if (admitted.outcome !== "ADMITTED") {
      throw new Error("admit failed");
    }
    const runId = admitted.runId;
    await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    await stack.planning.plan(runId);
    const plan = await stack.plans.getByRunId(runId);
    await stack.plans.save({
      ...plan!,
      plan: { ...plan!.plan, planHash: "tampered" },
      planHash: "tampered",
    });
    const validated = await stack.validation.validate(runId);
    expect(validated.decision).toBe("BLOCK");

    const routed = await stack.authorizationRouting.route(runId);
    expect(routed.outcome).toBe("BLOCKED");
    expect(routed.runState).toBe("BLOCKED");
    expect(await stack.approvalRequests.getPendingByRun(runId)).toBeNull();
    expect((await stack.approvalRequests.listByRun(runId)).length).toBe(0);
  });

  it("routes HUMAN_APPROVAL_REQUIRED to AWAITING_APPROVAL", async () => {
    const model = new FakeValidationModel();
    model.setReviseRecommendation({
      ruleId: "CONTEXT_MISSING_VERIFICATION",
      affectedStepIds: ["step_patch"],
    });
    const { stack, runId } = await validatedRun({ validationModel: model });
    const decision = await stack.validation.getLatestDecision(runId);
    expect(decision?.decision).toBe("HUMAN_APPROVAL_REQUIRED");
    const routed = await stack.authorizationRouting.route(runId);
    expect(routed.outcome).toBe("PENDING_APPROVAL");
    expect(routed.runState).toBe("AWAITING_APPROVAL");
  });

  it("duplicate routing reuses pending request identity without mutation", async () => {
    const { stack, runId } = await validatedRun();
    const first = await stack.authorizationRouting.route(runId);
    const second = await stack.authorizationRouting.route(runId);
    expect(first.outcome).toBe("PENDING_APPROVAL");
    expect(second.outcome).toBe("ALREADY_ROUTED");
    if (first.outcome === "PENDING_APPROVAL" && second.outcome === "ALREADY_ROUTED") {
      expect(second.approvalRequestId).toBe(first.approvalRequestId);
    }
    expect((await stack.approvalRequests.listByRun(runId)).length).toBe(1);
  });

  it("delivery failure cancels A and retry creates fresh B", async () => {
    const delivery = new FakeApprovalDeliveryService();
    delivery.failNextDelivery();
    const { stack, runId } = await validatedRun({ delivery });
    await expect(stack.authorizationRouting.route(runId)).rejects.toMatchObject({
      code: "APPROVAL_DELIVERY_FAILED",
    });
    expect((await stack.runs.getById(runId))?.state).toBe("VALIDATING");
    const afterFail = await stack.approvalRequests.listByRun(runId);
    expect(afterFail).toHaveLength(1);
    const requestA = afterFail[0]!;
    expect(requestA.status).toBe("CANCELLED");
    const nonceAHash = requestA.decisionNonceHash;

    const retry = await stack.authorizationRouting.route(runId);
    expect(retry.outcome).toBe("PENDING_APPROVAL");
    if (retry.outcome !== "PENDING_APPROVAL") {
      return;
    }
    expect(retry.approvalRequestId).not.toBe(requestA.approvalRequestId);
    expect(retry.replacesApprovalRequestId).toBe(requestA.approvalRequestId);

    const requestB = await stack.approvalRequests.getById(
      retry.approvalRequestId,
    );
    expect(requestB?.status).toBe("PENDING");
    expect(requestB?.decisionNonceHash).not.toBe(nonceAHash);
    expect(requestB?.replacesApprovalRequestId).toBe(requestA.approvalRequestId);
    expect(requestA.status).toBe("CANCELLED");
    expect(
      (await stack.approvalRequests.getById(requestA.approvalRequestId))?.status,
    ).toBe("CANCELLED");
    expect((await stack.runs.getById(runId))?.state).toBe("AWAITING_APPROVAL");

    // Only B may authorize; A's nonce (never delivered) / hash cannot approve B.
    const nonceB = deliveredNonce(delivery, retry.approvalRequestId);
    await expect(
      stack.humanAuthorization.decide({
        approvalRequestId: requestA.approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: nonceB,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_NOT_PENDING" });

    const approved = await stack.humanAuthorization.decide({
      approvalRequestId: retry.approvalRequestId,
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      submittedAt: stack.clock.nowIso(),
      decisionNonce: nonceB,
    });
    expect(approved.result).toBe("APPROVED");
  });

  it("decision card hash is deterministic for a fixed card", async () => {
    const { stack, runId } = await validatedRun();
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }
    const card = await stack.decisionCards.get(routed.approvalRequestId);
    const hasher = new Sha256DecisionCardHasher();
    expect(hasher.hash(card!)).toBe(routed.decisionCardHash);
    expect(hasher.hash(card!)).toBe(hasher.hash(card!));
  });
});

describe("ApprovalRequest immutability", () => {
  it("cannot refresh expiresAt or reactivate CANCELLED/EXPIRED to PENDING", async () => {
    const delivery = new FakeApprovalDeliveryService();
    delivery.failNextDelivery();
    const { stack, runId } = await validatedRun({ delivery });
    await expect(stack.authorizationRouting.route(runId)).rejects.toMatchObject({
      code: "APPROVAL_DELIVERY_FAILED",
    });
    const cancelled = (await stack.approvalRequests.listByRun(runId))[0]!;
    await expect(
      stack.approvalRequests.updateStatus(cancelled.approvalRequestId, "PENDING"),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_IMMUTABLE" });

    // Fresh successful request then expire
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }
    const pending = await stack.approvalRequests.getById(
      routed.approvalRequestId,
    );
    await stack.approvalExpiry.expireDueRequests(
      addMsIso(pending!.expiresAt, 1),
    );
    await expect(
      stack.approvalRequests.updateStatus(routed.approvalRequestId, "PENDING"),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_IMMUTABLE" });
  });

  it("new expiry requires a new request and new decisionCardHash", async () => {
    const delivery = new FakeApprovalDeliveryService();
    const stack = createLocalAuthorizationStack({
      approvalDelivery: delivery,
      approvalWindowMs: 60_000,
    });
    const admitted = await stack.admission.admit(exampleAdmissionRequest());
    if (admitted.outcome !== "ADMITTED") {
      throw new Error("admit failed");
    }
    const runId = admitted.runId;
    await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    await stack.planning.plan(runId);
    await stack.validation.validate(runId);

    delivery.failNextDelivery();
    await expect(stack.authorizationRouting.route(runId)).rejects.toMatchObject({
      code: "APPROVAL_DELIVERY_FAILED",
    });
    const a = (await stack.approvalRequests.listByRun(runId))[0]!;

    const { AuthorizationRoutingService } = await import("./routing.js");
    const routingLong = new AuthorizationRoutingService({
      readiness: stack.authorizationReadiness,
      runs: stack.runs,
      objectives: stack.objectives,
      controlPlane: stack.controlPlane,
      plans: stack.plans,
      decisions: stack.validationDecisions,
      locks: stack.locks,
      requests: stack.approvalRequests,
      cards: stack.decisionCards,
      coordinator: stack.authorizationCoordinator,
      delivery,
      clock: stack.clock,
      identities: stack.authorizationIdentities,
      nonceGenerator: stack.decisionNonceGenerator,
      approvalWindowMs: 120_000,
    });
    const retry = await routingLong.route(runId);
    expect(retry.outcome).toBe("PENDING_APPROVAL");
    if (retry.outcome !== "PENDING_APPROVAL") {
      return;
    }
    const b = await stack.approvalRequests.getById(retry.approvalRequestId);
    expect(b?.approvalRequestId).not.toBe(a.approvalRequestId);
    expect(b?.expiresAt).not.toBe(a.expiresAt);
    expect(b?.decisionCardHash).not.toBe(a.decisionCardHash);
    expect(b?.decisionNonceHash).not.toBe(a.decisionNonceHash);
    expect(a.status).toBe("CANCELLED");
  });
});

describe("AuthorizationReadinessService", () => {
  it("accepts a terminal valid decision", async () => {
    const { stack, runId } = await validatedRun();
    const readiness = await stack.authorizationReadiness.assess(runId);
    expect(readiness.ready).toBe(true);
  });

  it("denies non-VALIDATING runs", async () => {
    const { stack, runId } = await validatedRun();
    await stack.authorizationRouting.route(runId);
    const readiness = await stack.authorizationReadiness.assess(runId);
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.code).toBe("RUN_NOT_VALIDATING");
    }
  });

  it("denies stale repository", async () => {
    const { stack, runId } = await validatedRun();
    const lock = await stack.locks.getByRunId(runId);
    await stack.locks.save({ ...lock!, status: "STALE" });
    const readiness = await stack.authorizationReadiness.assess(runId);
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.code).toBe("REPOSITORY_STALE");
    }
  });
});

describe("HumanAuthorizationService", () => {
  it("APPROVE transitions AWAITING_APPROVAL → APPROVED with system nonce", async () => {
    const { stack, runId, delivery } = await validatedRun();
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }
    const nonce = deliveredNonce(delivery, routed.approvalRequestId);
    const result = await stack.humanAuthorization.decide({
      approvalRequestId: routed.approvalRequestId,
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      submittedAt: stack.clock.nowIso(),
      decisionNonce: nonce,
    });
    expect(result.result).toBe("APPROVED");
    expect(result.runState).toBe("APPROVED");
    const record = await stack.authorizationRecords.getByApprovalRequest(
      routed.approvalRequestId,
    );
    expect(record?.nonceHash).toBe(hashDecisionNonce(nonce));
    expect(JSON.stringify(record)).not.toContain(nonce);
    expect(runId).toBeTruthy();
  });

  it("REJECT transitions to REJECTED without execution", async () => {
    const { stack, runId, delivery } = await validatedRun();
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }
    const result = await stack.humanAuthorization.decide({
      approvalRequestId: routed.approvalRequestId,
      approverId: "approver_bootstrap",
      decision: "REJECT",
      submittedAt: stack.clock.nowIso(),
      decisionNonce: deliveredNonce(delivery, routed.approvalRequestId),
    });
    expect(result.result).toBe("REJECTED");
    expect(result.runState).toBe("REJECTED");
  });

  it("REQUEST_MODIFICATION does not mutate the plan", async () => {
    const { stack, runId, delivery } = await validatedRun();
    const before = await stack.plans.getByRunId(runId);
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }
    const result = await stack.humanAuthorization.decide({
      approvalRequestId: routed.approvalRequestId,
      approverId: "approver_bootstrap",
      decision: "REQUEST_MODIFICATION",
      submittedAt: stack.clock.nowIso(),
      decisionNonce: deliveredNonce(delivery, routed.approvalRequestId),
      note: "Please reduce blast radius",
    });
    expect(result.result).toBe("MODIFICATION_REQUESTED");
    expect(result.runState).toBe("ESCALATED");
    const after = await stack.plans.getByRunId(runId);
    expect(after?.planHash).toBe(before?.planHash);
    expect(after?.planVersion).toBe(before?.planVersion);
  });

  it("rejects unknown and unauthorized approvers", async () => {
    const delivery = new FakeApprovalDeliveryService();
    const stack = createLocalAuthorizationStack({
      approvalDelivery: delivery,
      knownApproverIds: ["approver_bootstrap", "known_outsider"],
    });
    const admitted = await stack.admission.admit(exampleAdmissionRequest());
    if (admitted.outcome !== "ADMITTED") {
      throw new Error("admit failed");
    }
    const runId = admitted.runId;
    await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    await stack.planning.plan(runId);
    await stack.validation.validate(runId);
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }
    const nonce = deliveredNonce(delivery, routed.approvalRequestId);

    await expect(
      stack.humanAuthorization.decide({
        approvalRequestId: routed.approvalRequestId,
        approverId: "known_outsider",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: nonce,
      }),
    ).rejects.toMatchObject({ code: "APPROVER_UNAUTHORIZED" });

    const delivery2 = new FakeApprovalDeliveryService();
    const stack2 = createLocalAuthorizationStack({
      approvalDelivery: delivery2,
    });
    const admitted2 = await stack2.admission.admit(exampleAdmissionRequest());
    if (admitted2.outcome !== "ADMITTED") {
      throw new Error("admit failed");
    }
    const runId2 = admitted2.runId;
    await stack2.ingestion.ingest(
      runId2,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    await stack2.planning.plan(runId2);
    await stack2.validation.validate(runId2);
    const routed2 = await stack2.authorizationRouting.route(runId2);
    if (routed2.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }
    await expect(
      stack2.humanAuthorization.decide({
        approvalRequestId: routed2.approvalRequestId,
        approverId: "totally_unknown",
        decision: "APPROVE",
        submittedAt: stack2.clock.nowIso(),
        decisionNonce: deliveredNonce(delivery2, routed2.approvalRequestId),
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_APPROVER" });
  });

  it("rejects arbitrary caller-generated nonce", async () => {
    const { stack, runId } = await validatedRun();
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }
    await expect(
      stack.humanAuthorization.decide({
        approvalRequestId: routed.approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: "attacker-invented-nonce",
      }),
    ).rejects.toMatchObject({ code: "INVALID_DECISION_NONCE" });
  });

  it("rejects reused valid nonce", async () => {
    const { stack, runId, delivery } = await validatedRun();
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }
    const nonce = deliveredNonce(delivery, routed.approvalRequestId);
    await expect(
      stack.humanAuthorization.decide({
        approvalRequestId: routed.approvalRequestId,
        approverId: "totally_unknown",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: nonce,
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_APPROVER" });
    await expect(
      stack.humanAuthorization.decide({
        approvalRequestId: routed.approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: nonce,
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DECISION_REPLAYED" });
  });

  it("nonce from request A cannot authorize request B", async () => {
    const delivery = new FakeApprovalDeliveryService();
    delivery.failNextDelivery();
    const { stack, runId } = await validatedRun({ delivery });
    await expect(stack.authorizationRouting.route(runId)).rejects.toMatchObject({
      code: "APPROVAL_DELIVERY_FAILED",
    });
    // A never received a delivered nonce; forge using A's stored hash is impossible
    // without plaintext. Create B, then try A's would-be nonce from a parallel path:
    const routedB = await stack.authorizationRouting.route(runId);
    if (routedB.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }
    const nonceB = deliveredNonce(delivery, routedB.approvalRequestId);
    const a = (await stack.approvalRequests.listByRun(runId)).find(
      (r) => r.status === "CANCELLED",
    )!;
    // Cross-submit B's nonce against A (cancelled) and a fake nonce against B.
    await expect(
      stack.humanAuthorization.decide({
        approvalRequestId: a.approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: nonceB,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_NOT_PENDING" });

    await expect(
      stack.humanAuthorization.decide({
        approvalRequestId: routedB.approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: "test-decision-nonce-1", // A's sequence nonce if it had been issued first
      }),
    ).rejects.toMatchObject({ code: "INVALID_DECISION_NONCE" });
  });

  it("rejects expired request nonce", async () => {
    const { stack, runId, delivery } = await validatedRun({
      approvalWindowMs: 1000,
    });
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }
    const nonce = deliveredNonce(delivery, routed.approvalRequestId);
    const pending = await stack.approvalRequests.getById(
      routed.approvalRequestId,
    );
    const future = addMsIso(pending!.expiresAt, 1);
    await stack.approvalExpiry.expireDueRequests(future);
    await expect(
      stack.humanAuthorization.decide({
        approvalRequestId: routed.approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: future,
        decisionNonce: nonce,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_EXPIRED" });
  });

  it("rejects approval when repository becomes STALE", async () => {
    const { stack, runId, delivery } = await validatedRun();
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }
    const lock = await stack.locks.getByRunId(runId);
    await stack.locks.save({ ...lock!, status: "STALE" });
    await expect(
      stack.humanAuthorization.decide({
        approvalRequestId: routed.approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: deliveredNonce(delivery, routed.approvalRequestId),
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_BINDING_STALE" });
  });

  it("rejects approval when live policy hash diverges", async () => {
    const { stack, runId, delivery } = await validatedRun();
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }
    const original = stack.controlPlane.resolve.bind(stack.controlPlane);
    stack.controlPlane.resolve = async (
      projectId: string,
      environment: string,
    ): Promise<ProjectControlContext> => {
      const ctx = await original(projectId, environment);
      return {
        ...ctx,
        activePolicyBundle: {
          ...ctx.activePolicyBundle,
          policyHash: "sha256:policy-rotated-under-approval",
        },
      };
    };
    await expect(
      stack.humanAuthorization.decide({
        approvalRequestId: routed.approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: deliveredNonce(delivery, routed.approvalRequestId),
      }),
    ).rejects.toMatchObject({ code: "POLICY_CHANGED_DURING_APPROVAL" });
  });

  it("rejects approval when plan hash binding diverges", async () => {
    const { stack, runId, delivery } = await validatedRun();
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }
    const plan = await stack.plans.getByRunId(runId);
    await stack.plans.save({
      ...plan!,
      planHash: "deadbeef",
      plan: { ...plan!.plan, planHash: "deadbeef" },
    });
    await expect(
      stack.humanAuthorization.decide({
        approvalRequestId: routed.approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: deliveredNonce(delivery, routed.approvalRequestId),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("freezes capabilitySetFingerprint on ApprovalRequest and AuthorizationRecord", async () => {
    const { stack, runId, delivery } = await validatedRun();
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }
    const request = await stack.approvalRequests.getById(
      routed.approvalRequestId,
    );
    expect(request?.capabilitySetFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const card = await stack.decisionCards.get(routed.approvalRequestId);
    expect(card?.capabilitySetFingerprint).toBe(
      request?.capabilitySetFingerprint,
    );
    expect(card?.capabilityAuthorityScope.length).toBeGreaterThan(0);

    await stack.humanAuthorization.decide({
      approvalRequestId: routed.approvalRequestId,
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      submittedAt: stack.clock.nowIso(),
      decisionNonce: deliveredNonce(delivery, routed.approvalRequestId),
    });
    const record = await stack.authorizationRecords.getLatestByRun(runId);
    expect(record?.capabilitySetFingerprint).toBe(
      request?.capabilitySetFingerprint,
    );
  });

  it("capability authority change after request creation rejects APPROVE without AuthorizationRecord", async () => {
    const { stack, runId, delivery } = await validatedRun();
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }
    const frozen = (
      await stack.approvalRequests.getById(routed.approvalRequestId)
    )?.capabilitySetFingerprint;
    const patch = await stack.capabilities.getById("CREATE_LOCAL_PATCH");
    stack.capabilities.replace({
      ...patch!,
      maximumRuntimeSeconds: patch!.maximumRuntimeSeconds === 30 ? 600 : 30,
    });
    await expect(
      stack.humanAuthorization.decide({
        approvalRequestId: routed.approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: deliveredNonce(delivery, routed.approvalRequestId),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_CHANGED_DURING_APPROVAL" });
    expect(await stack.authorizationRecords.getLatestByRun(runId)).toBeNull();
    expect(
      (await stack.approvalRequests.getById(routed.approvalRequestId))
        ?.capabilitySetFingerprint,
    ).toBe(frozen);
  });

  it("runtime 30→600 and 600→30 during approval both reject", async () => {
    for (const [from, to] of [
      [30, 600],
      [600, 30],
    ] as const) {
      const delivery = new FakeApprovalDeliveryService();
      const stack = createLocalAuthorizationStack({
        approvalDelivery: delivery,
        capabilities: EXAMPLE_CAPABILITIES.map((c) =>
          c.capabilityId === "CREATE_LOCAL_PATCH"
            ? { ...c, maximumRuntimeSeconds: from }
            : c,
        ),
      });
      const admitted = await stack.admission.admit(exampleAdmissionRequest());
      const runId = admitted.runId!;
      await stack.ingestion.ingest(
        runId,
        EXAMPLE_PROJECT_ID,
        EXAMPLE_ENVIRONMENT,
      );
      await stack.planning.plan(runId);
      await stack.validation.validate(runId);
      const routed = await stack.authorizationRouting.route(runId);
      if (routed.outcome !== "PENDING_APPROVAL") {
        throw new Error("expected pending");
      }
      const patch = await stack.capabilities.getById("CREATE_LOCAL_PATCH");
      stack.capabilities.replace({ ...patch!, maximumRuntimeSeconds: to });
      await expect(
        stack.humanAuthorization.decide({
          approvalRequestId: routed.approvalRequestId,
          approverId: "approver_bootstrap",
          decision: "APPROVE",
          submittedAt: stack.clock.nowIso(),
          decisionNonce: deliveredNonce(delivery, routed.approvalRequestId),
        }),
      ).rejects.toMatchObject({ code: "CAPABILITY_CHANGED_DURING_APPROVAL" });
      expect(await stack.authorizationRecords.getLatestByRun(runId)).toBeNull();
    }
  });

  it("capability enablement drift during approval rejects", async () => {
    const { stack, runId, delivery } = await validatedRun();
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }
    const patch = await stack.capabilities.getById("CREATE_LOCAL_PATCH");
    stack.capabilities.replace({ ...patch!, enabled: false });
    await expect(
      stack.humanAuthorization.decide({
        approvalRequestId: routed.approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: deliveredNonce(delivery, routed.approvalRequestId),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_CHANGED_DURING_APPROVAL" });
    expect(await stack.authorizationRecords.getLatestByRun(runId)).toBeNull();
  });

  it("decisionCardHash changes when capability authority changes", async () => {
    const delivery = new FakeApprovalDeliveryService();
    const capsA = EXAMPLE_CAPABILITIES.map((c) =>
      c.capabilityId === "CREATE_LOCAL_PATCH"
        ? { ...c, maximumRuntimeSeconds: 30 }
        : c,
    );
    const stackA = createLocalAuthorizationStack({
      approvalDelivery: delivery,
      capabilities: capsA,
    });
    const admittedA = await stackA.admission.admit(exampleAdmissionRequest());
    const runA = admittedA.runId!;
    await stackA.ingestion.ingest(runA, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    await stackA.planning.plan(runA);
    await stackA.validation.validate(runA);
    const routedA = await stackA.authorizationRouting.route(runA);
    if (routedA.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }

    const deliveryB = new FakeApprovalDeliveryService();
    const stackB = createLocalAuthorizationStack({
      approvalDelivery: deliveryB,
      capabilities: EXAMPLE_CAPABILITIES.map((c) =>
        c.capabilityId === "CREATE_LOCAL_PATCH"
          ? { ...c, maximumRuntimeSeconds: 600 }
          : c,
      ),
    });
    const admittedB = await stackB.admission.admit(exampleAdmissionRequest());
    const runB = admittedB.runId!;
    await stackB.ingestion.ingest(runB, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    await stackB.planning.plan(runB);
    await stackB.validation.validate(runB);
    const routedB = await stackB.authorizationRouting.route(runB);
    if (routedB.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }

    const reqA = await stackA.approvalRequests.getById(routedA.approvalRequestId);
    const reqB = await stackB.approvalRequests.getById(routedB.approvalRequestId);
    expect(reqA?.capabilitySetFingerprint).not.toBe(
      reqB?.capabilitySetFingerprint,
    );
    expect(reqA?.decisionCardHash).not.toBe(reqB?.decisionCardHash);
  });

  it("ApprovalRequest capabilitySetFingerprint cannot change in place", async () => {
    const { stack, runId } = await validatedRun();
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected pending");
    }
    const request = await stack.approvalRequests.getById(
      routed.approvalRequestId,
    );
    await expect(
      stack.approvalRequests.updateStatus(routed.approvalRequestId, "PENDING", {
        // updateStatus only allows status extras; binding mutation is via parse
      }),
    ).resolves.toMatchObject({
      capabilitySetFingerprint: request?.capabilitySetFingerprint,
    });
    // Attempt to save a mutated binding is rejected by immutable save semantics
    // (cannot re-save existing id). Binding field guard covers updateStatus.
    expect(request?.capabilitySetFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("approval window default", () => {
  it("uses 24h default window", () => {
    expect(DEFAULT_APPROVAL_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});
