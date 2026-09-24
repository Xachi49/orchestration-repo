import { describe, expect, it, vi } from "vitest";
import { AuthorizationError } from "../../authorization/errors.js";
import {
  approvalDeliveryIdempotencyKey,
  buildApprovalDeliveryEmailText,
  ResendApprovalDeliveryService,
} from "./resend-approval-delivery.js";
import type { ApprovalDecisionCard } from "../../domain/authorization/index.js";
import type { ApprovalRequest } from "../../domain/authorization/index.js";

function request(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    approvalRequestId: "apr_idem_1",
    runId: "run_1",
    projectId: "proj_1",
    objectiveId: "obj_1",
    objectiveVersion: 1,
    planId: "plan_1",
    planVersion: 2,
    planHash: "aa".repeat(32),
    repositoryCommitSha: "bb".repeat(20),
    repositoryFingerprint: "cc".repeat(32),
    policyBundleId: "pol_1",
    policyBundleHash: "dd".repeat(32),
    validationDecisionId: "vd_1",
    validationDecision: "HUMAN_APPROVAL_REQUIRED",
    requestReason: "HUMAN_APPROVAL_REQUIRED",
    requestedApproverIds: ["approver_rr_pilot"],
    createdAt: "2026-09-23T12:00:00.000Z",
    expiresAt: "2026-09-23T14:00:00.000Z",
    status: "PENDING",
    decisionCardHash: "ee".repeat(32),
    capabilitySetFingerprint: "ff".repeat(32),
    decisionNonceHash: "11".repeat(32),
    ...overrides,
  };
}

function card(): ApprovalDecisionCard {
  return {
    objectiveId: "obj_1",
    objectiveVersion: 1,
    objectiveOutcome: "ship",
    acceptanceCriteria: ["ok"],
    planId: "plan_1",
    planVersion: 2,
    planHash: "aa".repeat(32),
    validationDecisionId: "vd_1",
    validationDecision: "HUMAN_APPROVAL_REQUIRED",
    whyApprovalRequired: "human gate",
    proposedActions: [
      {
        stepId: "s1",
        actionType: "LOCAL_TASK",
        description: "work",
        targetIds: ["t1"],
      },
    ],
    targetsAffected: ["t1"],
    repositoryCommitSha: "bb".repeat(20),
    repositoryFingerprint: "cc".repeat(32),
    policyBundleId: "pol_1",
    policyBundleHash: "dd".repeat(32),
    blastRadius: {
      stepCount: 1,
      actionTypes: ["LOCAL_TASK"],
      riskLevels: ["LOW"],
    },
    verificationStrategy: ["test"],
    rollbackContainmentStrategy: ["revert"],
    unresolvedAssumptions: [],
    approvalEligibleFindingSummaries: ["needs review"],
    capabilitySetFingerprint: "ff".repeat(32),
    capabilityAuthorityScope: [],
    verificationCoverageSummary: [],
    createdAt: "2026-09-23T12:00:00.000Z",
    expiresAt: "2026-09-23T14:00:00.000Z",
  };
}

describe("ResendApprovalDeliveryService", () => {
  it("sends plaintext nonce to provider but never stores it on the service", async () => {
    const nonce = "plaintext-decision-nonce-fixture";
    let capturedText = "";
    let capturedMeta: Record<string, unknown> | undefined;
    const transport = {
      sendEmail: vi.fn(async (input: {
        text: string;
        idempotencyKey: string;
        to: string;
        from: string;
      }) => {
        capturedText = input.text;
        capturedMeta = {
          idempotencyKey: input.idempotencyKey,
          to: input.to,
          from: input.from,
        };
        expect(input.text).toContain(nonce);
        return { id: "email_abc" };
      }),
    };
    const delivery = new ResendApprovalDeliveryService({
      apiKey: "re_test",
      from: "orchestrator@example.com",
      to: "approvers@example.com",
      transport,
    });
    const req = request();
    await delivery.deliverApprovalRequest({
      request: req,
      card: card(),
      decisionNonce: nonce,
    });
    expect(capturedText).toContain(nonce);
    expect(capturedText).toContain("EMAIL RECEIVED != APPROVED");
    expect(capturedText).toContain(req.approvalRequestId);
    expect(capturedText).toContain("approver_rr_pilot");
    expect(JSON.stringify(delivery.deliveredMessageIds)).not.toContain(nonce);
    expect(JSON.stringify(capturedMeta)).not.toContain(nonce);
    expect(req.decisionNonceHash).toBe("11".repeat(32));
    expect(JSON.stringify(req)).not.toContain(nonce);
  });

  it("uses deterministic idempotency key bound to approvalRequestId", async () => {
    const keys: string[] = [];
    const transport = {
      sendEmail: vi.fn(async (input: { idempotencyKey: string }) => {
        keys.push(input.idempotencyKey);
        return { id: `email_${keys.length}` };
      }),
    };
    const delivery = new ResendApprovalDeliveryService({
      apiKey: "re_test",
      from: "a@example.com",
      to: "b@example.com",
      transport,
    });
    const req = request({ approvalRequestId: "apr_stable" });
    await delivery.deliverApprovalRequest({
      request: req,
      card: card(),
      decisionNonce: "n1",
    });
    await delivery.deliverApprovalRequest({
      request: req,
      card: card(),
      decisionNonce: "n1",
    });
    expect(keys[0]).toBe(approvalDeliveryIdempotencyKey("apr_stable"));
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe("approval-delivery:v1:apr_stable");
  });

  it("email text has no approve/reject links or nonce query params", () => {
    const text = buildApprovalDeliveryEmailText({
      request: request(),
      card: card(),
      decisionNonce: "secret-nonce",
    });
    expect(text).not.toMatch(/https?:\/\/\S*decisionNonce=/i);
    expect(text).not.toMatch(/approve\?|reject\?/i);
    expect(text).toContain("POST /v1/approval-requests/{id}/decision");
  });

  it("provider failure surfaces APPROVAL_DELIVERY_FAILED", async () => {
    const delivery = new ResendApprovalDeliveryService({
      apiKey: "re_test",
      from: "a@example.com",
      to: "b@example.com",
      transport: {
        sendEmail: async () => {
          throw new Error("resend down");
        },
      },
    });
    await expect(
      delivery.deliverApprovalRequest({
        request: request(),
        card: card(),
        decisionNonce: "n",
      }),
    ).rejects.toMatchObject({
      code: "APPROVAL_DELIVERY_FAILED",
    } satisfies Partial<AuthorizationError>);
  });

  it("does not implement customer recovery email fields", async () => {
    const transport = {
      sendEmail: vi.fn(async (input: Record<string, unknown>) => {
        expect(input).not.toHaveProperty("leadEmail");
        expect(input).not.toHaveProperty("recoveryAttemptId");
        expect(Object.keys(input).sort()).toEqual(
          ["apiKey", "from", "idempotencyKey", "subject", "text", "to"].sort(),
        );
        return { id: "email_x" };
      }),
    };
    const delivery = new ResendApprovalDeliveryService({
      apiKey: "re_test",
      from: "a@example.com",
      to: "b@example.com",
      transport,
    });
    await delivery.deliverApprovalRequest({
      request: request(),
      card: card(),
      decisionNonce: "n",
    });
    expect(transport.sendEmail).toHaveBeenCalledTimes(1);
  });
});
