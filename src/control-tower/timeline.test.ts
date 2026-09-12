import { describe, expect, it } from "vitest";
import { deriveRunTimeline } from "./timeline.js";
import { sanitizeApprovalRequest } from "./sanitizers.js";

describe("Control Tower timeline mapping", () => {
  it("PASS / AWAITING_APPROVAL is not APPROVED execution", () => {
    const stages = deriveRunTimeline({
      state: "AWAITING_APPROVAL",
      hasCompletion: false,
    });
    expect(stages.find((s) => s.stageId === "VALIDATION")?.status).toBe(
      "SUCCESS",
    );
    expect(stages.find((s) => s.stageId === "AUTHORIZATION")?.status).toBe(
      "AWAITING_ACTION",
    );
    expect(stages.find((s) => s.stageId === "EXECUTION")?.status).toBe(
      "NOT_STARTED",
    );
  });

  it("EXECUTING does not display VERIFIED or COMPLETED", () => {
    const stages = deriveRunTimeline({
      state: "EXECUTING",
      hasCompletion: false,
    });
    expect(stages.find((s) => s.stageId === "EXECUTION")?.status).toBe(
      "IN_PROGRESS",
    );
    expect(stages.find((s) => s.stageId === "VERIFICATION")?.status).toBe(
      "NOT_STARTED",
    );
    expect(stages.find((s) => s.stageId === "COMPLETION")?.status).toBe(
      "NOT_STARTED",
    );
  });

  it("COMPLETED without CompletionRecord is not SUCCESS completion", () => {
    const stages = deriveRunTimeline({
      state: "COMPLETED",
      hasCompletion: false,
    });
    expect(stages.find((s) => s.stageId === "COMPLETION")?.status).toBe(
      "IN_PROGRESS",
    );
  });

  it("COMPLETED with CompletionRecord is SUCCESS", () => {
    const stages = deriveRunTimeline({
      state: "COMPLETED",
      hasCompletion: true,
    });
    expect(stages.find((s) => s.stageId === "COMPLETION")?.status).toBe(
      "SUCCESS",
    );
  });
});

describe("approval sanitizer", () => {
  it("omits decisionNonceHash", () => {
    const publicRequest = sanitizeApprovalRequest({
      approvalRequestId: "apr_1",
      runId: "run_1",
      projectId: "proj_local",
      objectiveId: "obj_1",
      objectiveVersion: 1,
      planId: "plan_1",
      planVersion: 1,
      planHash: "ph",
      repositoryCommitSha: "sha",
      repositoryFingerprint: "rf",
      policyBundleId: "pol",
      policyBundleHash: "pbh",
      validationDecisionId: "vd",
      validationDecision: "HUMAN_APPROVAL_REQUIRED",
      requestReason: "HUMAN_APPROVAL_REQUIRED",
      requestedApproverIds: ["approver_bootstrap"],
      createdAt: "2026-09-09T12:00:00.000Z",
      expiresAt: "2026-09-09T13:00:00.000Z",
      status: "PENDING",
      decisionCardHash: "dch",
      capabilitySetFingerprint: "cap",
      decisionNonceHash: "SECRET_HASH_MUST_NOT_LEAK",
    });
    expect(publicRequest).not.toHaveProperty("decisionNonceHash");
    expect(JSON.stringify(publicRequest)).not.toContain("SECRET_HASH");
  });
});
