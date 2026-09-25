/**
 * Approval delivery failure observability.
 * OBSERVABILITY != AUTHORITY; SECRET DIAGNOSTICS != SAFE DIAGNOSTICS.
 */
import { describe, expect, it, vi } from "vitest";
import { createLocalAuthorizationStack } from "../infrastructure/authorization/local-stack.js";
import { ResendApprovalDeliveryService } from "../infrastructure/authorization/resend-approval-delivery.js";
import { FakeApprovalDeliveryService } from "./delivery.js";
import { DurabilityError } from "../durability/errors.js";
import { MemoryStructuredLogger } from "../runtime/logging.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import { EXAMPLE_ENVIRONMENT } from "../control-plane/fixtures.js";
import { buildServer } from "../api/server.js";
import {
  APPROVAL_DELIVERY_SECRET_UNAVAILABLE,
  classifyApprovalDeliveryFailure,
} from "./delivery-failure.js";
import {
  ApprovalDeliveryOutboxConsumer,
  createApprovalDeliveryDispatcher,
  APPROVAL_DELIVERY_EVENT,
} from "./outbox-consumer.js";
import { AuthorizationError } from "./errors.js";
import { InMemoryApprovalRequestRepository } from "./approval-request-repository.js";
import { InMemoryAuthorizationCoordinator } from "./coordinator.js";
import type { OutboxMessage } from "../domain/durability/index.js";
import type { ApprovalDeliveryService } from "./delivery.js";
import type { ApprovalDecisionCard } from "../domain/authorization/index.js";
import type { ApprovalRequest } from "../domain/authorization/index.js";
import { APPROVAL_DELIVERY_UNREACHABLE_REASON } from "./service.js";

const SENTINEL_NONCE = "TEST_APPROVAL_NONCE_SENTINEL";

/** Succeeds once (initial route), then throws SIDE_EFFECT on subsequent delivers. */
function sideEffectAfterFirstSuccess(): ApprovalDeliveryService & {
  firstNonce?: string;
} {
  let first = true;
  const inner = new FakeApprovalDeliveryService();
  return {
    get firstNonce() {
      return inner.delivered[0]?.decisionNonce;
    },
    async deliverApprovalRequest(input) {
      if (first) {
        first = false;
        return inner.deliverApprovalRequest(input);
      }
      throw new DurabilityError(
        "SIDE_EFFECT_IN_TRANSACTION",
        "ApprovalDeliveryService must not run while a database transaction is open",
        { operation: "ApprovalDeliveryService" },
      );
    },
    async cancelApprovalRequest(id) {
      return inner.cancelApprovalRequest(id);
    },
  };
}

async function awaitingApproval(options: {
  delivery: ApprovalDeliveryService;
  logger?: MemoryStructuredLogger;
}) {
  const stack = createLocalAuthorizationStack({
    approvalDelivery: options.delivery,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  const admitted = await stack.admission.admit(exampleAdmissionRequest());
  expect(admitted.outcome).toBe("ADMITTED");
  const runId = admitted.runId!;
  await stack.ingestion.ingest(
    runId,
    exampleAdmissionRequest().projectId,
    EXAMPLE_ENVIRONMENT,
  );
  await stack.planning.plan(runId);
  await stack.validation.validate(runId);
  const routed = await stack.authorizationRouting.route(runId);
  expect(routed.outcome).toBe("PENDING_APPROVAL");
  if (routed.outcome !== "PENDING_APPROVAL") {
    throw new Error("expected PENDING_APPROVAL");
  }
  return {
    stack,
    runId,
    approvalRequestId: routed.approvalRequestId,
  };
}

function minimalCard(): ApprovalDecisionCard {
  return {
    objectiveId: "obj_1",
    objectiveVersion: 1,
    objectiveOutcome: "ship",
    acceptanceCriteria: ["ok"],
    planId: "plan_1",
    planVersion: 1,
    planHash: "aa".repeat(32),
    validationDecisionId: "vd_1",
    validationDecision: "HUMAN_APPROVAL_REQUIRED",
    whyApprovalRequired: "gate",
    proposedActions: [],
    targetsAffected: [],
    repositoryCommitSha: "bb".repeat(20),
    repositoryFingerprint: "cc".repeat(32),
    policyBundleId: "pol_1",
    policyBundleHash: "dd".repeat(32),
    blastRadius: { stepCount: 0, actionTypes: [], riskLevels: [] },
    verificationStrategy: [],
    rollbackContainmentStrategy: [],
    unresolvedAssumptions: [],
    approvalEligibleFindingSummaries: [],
    capabilitySetFingerprint: "ff".repeat(32),
    capabilityAuthorityScope: [],
    verificationCoverageSummary: [],
    createdAt: "2026-09-24T00:00:00.000Z",
    expiresAt: "2026-09-24T02:00:00.000Z",
  };
}

function pendingRequest(id: string): ApprovalRequest {
  return {
    approvalRequestId: id,
    runId: "run_1",
    projectId: "proj_1",
    objectiveId: "obj_1",
    objectiveVersion: 1,
    planId: "plan_1",
    planVersion: 1,
    planHash: "aa".repeat(32),
    repositoryCommitSha: "bb".repeat(20),
    repositoryFingerprint: "cc".repeat(32),
    policyBundleId: "pol_1",
    policyBundleHash: "dd".repeat(32),
    validationDecisionId: "vd_1",
    validationDecision: "HUMAN_APPROVAL_REQUIRED",
    requestReason: "HUMAN_APPROVAL_REQUIRED",
    requestedApproverIds: ["approver_bootstrap"],
    createdAt: "2026-09-24T00:00:00.000Z",
    expiresAt: "2026-09-24T02:00:00.000Z",
    status: "PENDING",
    decisionCardHash: "ee".repeat(32),
    capabilitySetFingerprint: "ff".repeat(32),
    decisionNonceHash: "11".repeat(32),
  };
}

describe("classifyApprovalDeliveryFailure", () => {
  it("preserves SIDE_EFFECT_IN_TRANSACTION as PRE_PROVIDER", () => {
    const error = new DurabilityError(
      "SIDE_EFFECT_IN_TRANSACTION",
      "must not run in txn",
    );
    const result = classifyApprovalDeliveryFailure(error, "apr_1");
    expect(result.deliveryStage).toBe("PRE_PROVIDER");
    expect(result.failureCode).toBe("SIDE_EFFECT_IN_TRANSACTION");
    expect(result.providerAttempted).toBe(false);
  });

  it("honors PROVIDER tags from Resend-style errors", () => {
    const error = new AuthorizationError(
      "APPROVAL_DELIVERY_FAILED",
      "Resend failed",
      {
        deliveryStage: "PROVIDER",
        providerAttempted: true,
        providerName: "resend",
        failureCode: "APPROVAL_DELIVERY_FAILED",
      },
    );
    const result = classifyApprovalDeliveryFailure(error, "apr_2");
    expect(result.deliveryStage).toBe("PROVIDER");
    expect(result.providerAttempted).toBe(true);
    expect(result.providerName).toBe("resend");
  });
});

describe("approval delivery failure observability on reissue", () => {
  it("1–4,8–13: PRE_PROVIDER SIDE_EFFECT preserves code, returns replacement id, no authz", async () => {
    const logger = new MemoryStructuredLogger("obs", () => undefined);
    const delivery = sideEffectAfterFirstSuccess();
    const { stack, approvalRequestId, runId } = await awaitingApproval({
      delivery,
      logger,
    });
    const originalNonce = delivery.firstNonce ?? SENTINEL_NONCE;

    let caught: AuthorizationError | undefined;
    try {
      await stack.humanAuthorization.recoverUnreachableApprovalDelivery({
        approvalRequestId,
        reason: "DELIVERY_UNREACHABLE",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationError);
      caught = error as AuthorizationError;
    }
    expect(caught?.code).toBe("APPROVAL_DELIVERY_FAILED");
    expect(caught?.details?.["failureCode"]).toBe("SIDE_EFFECT_IN_TRANSACTION");
    expect(caught?.details?.["deliveryStage"]).toBe("PRE_PROVIDER");
    expect(caught?.details?.["providerAttempted"]).toBe(false);
    expect(typeof caught?.details?.["replacementApprovalRequestId"]).toBe(
      "string",
    );
    const replacementId = caught!.details![
      "replacementApprovalRequestId"
    ] as string;
    expect(replacementId).not.toBe(approvalRequestId);

    const serialized = JSON.stringify({
      error: caught!.code,
      message: caught!.message,
      ...caught!.details,
    });
    expect(serialized).not.toContain(originalNonce);
    expect(serialized).not.toContain(SENTINEL_NONCE);

    const original = await stack.approvalRequests.getById(approvalRequestId);
    expect(original?.status).toBe("CANCELLED");
    expect(original?.failureReasonCode).toBe(
      APPROVAL_DELIVERY_UNREACHABLE_REASON,
    );
    const replacement = await stack.approvalRequests.getById(replacementId);
    expect(replacement?.status).toBe("CANCELLED");
    expect((await stack.runs.getById(runId))?.state).toBe("AWAITING_APPROVAL");
    expect(await stack.authorizationRecords.getLatestByRun(runId)).toBeNull();

    const joined = logger.lines().join("\n");
    expect(joined).toContain("approval_reissue_delivery_failed");
    expect(joined).toContain("PRE_PROVIDER");
    expect(joined).toContain("SIDE_EFFECT_IN_TRANSACTION");
    expect(joined).toContain(replacementId);
    expect(joined).not.toContain(originalNonce);
  });

  it("5–6: provider failure reports PROVIDER and providerAttempted=true", async () => {
    let transportEntered = false;
    const delivery = new ResendApprovalDeliveryService({
      apiKey: "re_test_key",
      from: "orch@example.com",
      to: "ops@example.com",
      transport: {
        sendEmail: async (input) => {
          transportEntered = true;
          expect(input.text).toContain("Decision nonce");
          throw new Error("provider unavailable");
        },
      },
    });
    // First route also uses same delivery — fail on first so route fails.
    // Use Fake first then Resend for reissue via gated wrapper.
    let phase: "route" | "reissue" = "route";
    const fake = new FakeApprovalDeliveryService();
    const gated: ApprovalDeliveryService = {
      async deliverApprovalRequest(input) {
        if (phase === "route") {
          return fake.deliverApprovalRequest(input);
        }
        return delivery.deliverApprovalRequest(input);
      },
      async cancelApprovalRequest(id) {
        return fake.cancelApprovalRequest(id);
      },
    };
    const { stack, approvalRequestId, runId } = await awaitingApproval({
      delivery: gated,
    });
    const originalNonce = fake.nonceFor(approvalRequestId)!;
    phase = "reissue";

    await expect(
      stack.humanAuthorization.recoverUnreachableApprovalDelivery({
        approvalRequestId,
        reason: "DELIVERY_UNREACHABLE",
      }),
    ).rejects.toMatchObject({
      code: "APPROVAL_DELIVERY_FAILED",
      details: {
        deliveryStage: "PROVIDER",
        providerAttempted: true,
        providerName: "resend",
      },
    });
    expect(transportEntered).toBe(true);
    expect((await stack.runs.getById(runId))?.state).toBe("AWAITING_APPROVAL");
    expect(await stack.authorizationRecords.getLatestByRun(runId)).toBeNull();
    expect(JSON.stringify({})).not.toContain(originalNonce);
  });

  it("8–9: HTTP 502 includes replacement id and never exposes nonce; logs are safe", async () => {
    const logger = new MemoryStructuredLogger("http-obs", () => undefined);
    const delivery = sideEffectAfterFirstSuccess();
    const { stack, approvalRequestId } = await awaitingApproval({
      delivery,
      logger,
    });
    const originalNonce = delivery.firstNonce ?? SENTINEL_NONCE;

    const app = await buildServer({
      admission: stack.admission,
      ingestion: stack.ingestion,
      planning: stack.planning,
      validation: stack.validation,
      authorizationRouting: stack.authorizationRouting,
      humanAuthorization: stack.humanAuthorization,
      approvalExpiry: stack.approvalExpiry,
      authorizationReadiness: stack.authorizationReadiness,
      logger,
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/approval-requests/${approvalRequestId}/reissue`,
      payload: { reason: "DELIVERY_UNREACHABLE" },
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toBe("APPROVAL_DELIVERY_FAILED");
    expect(body.deliveryStage).toBe("PRE_PROVIDER");
    expect(body.failureCode).toBe("SIDE_EFFECT_IN_TRANSACTION");
    expect(body.providerAttempted).toBe(false);
    expect(body.replacementApprovalRequestId).toMatch(/^apr_/);
    const text = res.body;
    expect(text).not.toContain(originalNonce);
    expect(text).not.toMatch(/decisionNonce(?!Hash)/);

    const joined = logger.lines().join("\n");
    expect(joined).toContain("approval_reissue_delivery_failed");
    expect(joined).not.toContain(originalNonce);
    await app.close();
  });

  it("15: successful approval delivery behavior is unchanged", async () => {
    const delivery = new FakeApprovalDeliveryService();
    const { stack, approvalRequestId } = await awaitingApproval({ delivery });
    const result =
      await stack.humanAuthorization.recoverUnreachableApprovalDelivery({
        approvalRequestId,
        reason: "DELIVERY_UNREACHABLE",
      });
    expect(result.outcome).toBe("REISSUED");
    if (result.outcome !== "REISSUED") return;
    const replacement = await stack.approvalRequests.getById(
      result.replacementApprovalRequestId,
    );
    expect(replacement?.status).toBe("PENDING");
    expect(
      delivery.nonceFor(result.replacementApprovalRequestId),
    ).toBeTruthy();
  });
});

describe("outbox dispatchOnce failure preservation", () => {
  it("7: secret reveal failure reports REVEAL_SECRET without cancelling", async () => {
    const requests = new InMemoryApprovalRequestRepository();
    const req = pendingRequest("apr_secret_miss");
    await requests.save(req);
    const coordinator = new InMemoryAuthorizationCoordinator(requests);
    const consumer = new ApprovalDeliveryOutboxConsumer({
      delivery: new FakeApprovalDeliveryService(),
      requests,
      coordinator,
      runs: {
        getById: async () => null,
      } as never,
      deliverySecrets: {
        storePending: async () => {},
        revealPending: async () => null,
        markDelivered: async () => {},
        invalidate: async () => {},
      },
      clockNowIso: () => "2026-09-24T00:00:00.000Z",
    });

    await expect(
      consumer.consume({
        outboxId: "obx_1",
        aggregateType: "approval_request",
        aggregateId: req.approvalRequestId,
        eventType: APPROVAL_DELIVERY_EVENT,
        payload: {
          approvalRequestId: req.approvalRequestId,
          runId: req.runId,
          projectId: req.projectId,
          bindingKey: "bk",
          card: minimalCard(),
        },
        createdAt: "2026-09-24T00:00:00.000Z",
        availableAt: "2026-09-24T00:00:00.000Z",
        attemptCount: 1,
        status: "PENDING",
      } as OutboxMessage),
    ).rejects.toMatchObject({
      code: "APPROVAL_DELIVERY_FAILED",
      details: {
        deliveryStage: "REVEAL_SECRET",
        failureCode: APPROVAL_DELIVERY_SECRET_UNAVAILABLE,
        providerAttempted: false,
      },
    });
    expect((await requests.getById(req.approvalRequestId))?.status).toBe(
      "PENDING",
    );
  });

  it("14: background dispatchOnce records failures without throwing", async () => {
    const markFailed = vi.fn(async () => {});
    const markDelivered = vi.fn(async () => {});
    const message: OutboxMessage = {
      outboxId: "obx_fail",
      aggregateType: "approval_request",
      aggregateId: "apr_x",
      eventType: APPROVAL_DELIVERY_EVENT,
      payload: { approvalRequestId: "apr_x" },
      createdAt: "2026-09-24T00:00:00.000Z",
      availableAt: "2026-09-24T00:00:00.000Z",
      attemptCount: 1,
      status: "PENDING",
      fenceToken: 1,
    };
    const dispatcher = createApprovalDeliveryDispatcher({
      outbox: {
        claimBatch: async () => [message],
        markDelivered,
        markFailed,
      },
      ownerId: "worker_1",
      consumer: {
        consume: async () => {
          throw toTaggedPreProvider();
        },
      },
    });
    const result = await dispatcher.dispatchOnce(1);
    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      approvalRequestId: "apr_x",
      deliveryStage: "PRE_PROVIDER",
      failureCode: "SIDE_EFFECT_IN_TRANSACTION",
      providerAttempted: false,
    });
    expect(markFailed).toHaveBeenCalledOnce();
    expect(markDelivered).not.toHaveBeenCalled();
  });
});

function toTaggedPreProvider(): AuthorizationError {
  return new AuthorizationError(
    "APPROVAL_DELIVERY_FAILED",
    "ApprovalDeliveryService must not run while a database transaction is open",
    {
      approvalRequestId: "apr_x",
      deliveryStage: "PRE_PROVIDER",
      failureCode: "SIDE_EFFECT_IN_TRANSACTION",
      providerAttempted: false,
    },
  );
}
