import { describe, expect, it, vi } from "vitest";
import { FakeApprovalDeliveryService } from "../../authorization/delivery.js";
import {
  ApprovalDeliverySelectionError,
  selectApprovalDelivery,
} from "./approval-delivery-selection.js";
import { ResendApprovalDeliveryService } from "./resend-approval-delivery.js";

const resendEnv = {
  ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER: "resend",
  RESEND_API_KEY: "re_test_fixture_not_a_secret",
  APPROVAL_DELIVERY_EMAIL_FROM: "orchestrator@example.com",
  APPROVAL_DELIVERY_EMAIL_TO: "approvers@example.com",
};

describe("selectApprovalDelivery", () => {
  it("PRODUCTION + resend selects ResendApprovalDeliveryService", () => {
    const selected = selectApprovalDelivery({
      runtimeEnvironment: "PRODUCTION",
      env: resendEnv,
      resendTransport: {
        sendEmail: async () => ({ id: "email_unused" }),
      },
    });
    expect(selected.approvalDeliveryProvider).toBe("RESEND");
    expect(selected.approvalDeliveryConfigured).toBe(true);
    expect(selected.delivery).toBeInstanceOf(ResendApprovalDeliveryService);
  });

  it("PRODUCTION cannot select Fake approval delivery via env", () => {
    expect(() =>
      selectApprovalDelivery({
        runtimeEnvironment: "PRODUCTION",
        env: {
          ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER: "fake",
          RESEND_API_KEY: "re_present_but_irrelevant",
        },
      }),
    ).toThrow(ApprovalDeliverySelectionError);
    expect(() =>
      selectApprovalDelivery({
        runtimeEnvironment: "PRODUCTION",
        env: {
          ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER: "fake",
        },
      }),
    ).toThrow(/FAKE DELIVERY|fake is forbidden/i);
  });

  it("PRODUCTION cannot inject FakeApprovalDeliveryService", () => {
    expect(() =>
      selectApprovalDelivery({
        runtimeEnvironment: "PRODUCTION",
        env: resendEnv,
        approvalDelivery: new FakeApprovalDeliveryService(),
      }),
    ).toThrow(/FAKE DELIVERY|FakeApprovalDeliveryService is forbidden/);
  });

  it("missing provider fails PRODUCTION startup selection", () => {
    expect(() =>
      selectApprovalDelivery({
        runtimeEnvironment: "PRODUCTION",
        env: {
          RESEND_API_KEY: "re_present_but_provider_missing",
          APPROVAL_DELIVERY_EMAIL_FROM: "orchestrator@example.com",
          APPROVAL_DELIVERY_EMAIL_TO: "approvers@example.com",
        },
      }),
    ).toThrow(/ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER/);
  });

  it("unsupported provider fails PRODUCTION startup selection", () => {
    expect(() =>
      selectApprovalDelivery({
        runtimeEnvironment: "PRODUCTION",
        env: {
          ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER: "sendgrid",
          RESEND_API_KEY: "re_test",
          APPROVAL_DELIVERY_EMAIL_FROM: "orchestrator@example.com",
          APPROVAL_DELIVERY_EMAIL_TO: "approvers@example.com",
        },
      }),
    ).toThrow(/unsupported|resend/i);
  });

  it("missing Resend key fails PRODUCTION", () => {
    expect(() =>
      selectApprovalDelivery({
        runtimeEnvironment: "PRODUCTION",
        env: {
          ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER: "resend",
          APPROVAL_DELIVERY_EMAIL_FROM: "orchestrator@example.com",
          APPROVAL_DELIVERY_EMAIL_TO: "approvers@example.com",
        },
      }),
    ).toThrow(/RESEND_API_KEY/);
  });

  it("missing sender fails PRODUCTION", () => {
    expect(() =>
      selectApprovalDelivery({
        runtimeEnvironment: "PRODUCTION",
        env: {
          ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER: "resend",
          RESEND_API_KEY: "re_test",
          APPROVAL_DELIVERY_EMAIL_TO: "approvers@example.com",
        },
      }),
    ).toThrow(/APPROVAL_DELIVERY_EMAIL_FROM/);
  });

  it("missing recipient fails PRODUCTION", () => {
    expect(() =>
      selectApprovalDelivery({
        runtimeEnvironment: "PRODUCTION",
        env: {
          ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER: "resend",
          RESEND_API_KEY: "re_test",
          APPROVAL_DELIVERY_EMAIL_FROM: "orchestrator@example.com",
        },
      }),
    ).toThrow(/APPROVAL_DELIVERY_EMAIL_TO/);
  });

  it("invalid email addresses fail PRODUCTION", () => {
    expect(() =>
      selectApprovalDelivery({
        runtimeEnvironment: "PRODUCTION",
        env: {
          ...resendEnv,
          APPROVAL_DELIVERY_EMAIL_FROM: "not-an-email",
        },
      }),
    ).toThrow(/FROM.*invalid|valid email/i);
    expect(() =>
      selectApprovalDelivery({
        runtimeEnvironment: "PRODUCTION",
        env: {
          ...resendEnv,
          APPROVAL_DELIVERY_EMAIL_TO: "also-bad",
        },
      }),
    ).toThrow(/TO.*invalid|valid email/i);
  });

  it("non-production Fake behavior remains available by default", () => {
    const selected = selectApprovalDelivery({
      runtimeEnvironment: "TEST",
      env: {},
    });
    expect(selected.approvalDeliveryProvider).toBe("FAKE");
    expect(selected.delivery).toBeInstanceOf(FakeApprovalDeliveryService);
  });

  it("never infers resend from RESEND_API_KEY alone", () => {
    const selected = selectApprovalDelivery({
      runtimeEnvironment: "TEST",
      env: { RESEND_API_KEY: "re_present_alone" },
    });
    expect(selected.delivery).toBeInstanceOf(FakeApprovalDeliveryService);
  });

  it("RECOVERY_PROVIDER_MODE is independent of approval delivery selection", () => {
    const selected = selectApprovalDelivery({
      runtimeEnvironment: "PRODUCTION",
      env: {
        ...resendEnv,
        RECOVERY_PROVIDER_MODE: "SHADOW",
      },
      resendTransport: {
        sendEmail: async () => ({ id: "email_shadow" }),
      },
    });
    expect(selected.approvalDeliveryProvider).toBe("RESEND");
    // Selection does not read or mutate recovery mode.
    expect(resendEnv).not.toHaveProperty("RECOVERY_PROVIDER_MODE");
  });

  it("Resend transport never receives customer Lead.email destinations", async () => {
    const sendEmail = vi.fn(async (input: { to: string }) => {
      expect(input.to).toBe("approvers@example.com");
      expect(input.to).not.toBe("customer@lead.example");
      return { id: "email_op" };
    });
    const selected = selectApprovalDelivery({
      runtimeEnvironment: "PRODUCTION",
      env: resendEnv,
      resendTransport: { sendEmail },
    });
    await (
      selected.delivery as ResendApprovalDeliveryService
    ).deliverApprovalRequest({
      request: minimalRequest(),
      card: minimalCard(),
      decisionNonce: "nonce-fixture-not-for-logs",
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![0].to).toBe("approvers@example.com");
  });
});

function minimalRequest() {
  return {
    approvalRequestId: "apr_test_1",
    runId: "run_test_1",
    projectId: "proj_test",
    objectiveId: "obj_test",
    objectiveVersion: 1,
    planId: "plan_test",
    planVersion: 1,
    planHash: "a".repeat(64),
    repositoryCommitSha: "b".repeat(40),
    repositoryFingerprint: "c".repeat(64),
    policyBundleId: "policy_test",
    policyBundleHash: "d".repeat(64),
    validationDecisionId: "vd_test",
    validationDecision: "HUMAN_APPROVAL_REQUIRED" as const,
    requestReason: "HUMAN_APPROVAL_REQUIRED" as const,
    requestedApproverIds: ["approver_rr_pilot"],
    createdAt: "2026-09-23T12:00:00.000Z",
    expiresAt: "2026-09-23T13:00:00.000Z",
    status: "PENDING" as const,
    decisionCardHash: "e".repeat(64),
    capabilitySetFingerprint: "f".repeat(64),
    decisionNonceHash: "1".repeat(64),
  };
}

function minimalCard() {
  return {
    objectiveId: "obj_test",
    objectiveVersion: 1,
    objectiveOutcome: "test outcome",
    acceptanceCriteria: ["done"],
    planId: "plan_test",
    planVersion: 1,
    planHash: "a".repeat(64),
    validationDecisionId: "vd_test",
    validationDecision: "HUMAN_APPROVAL_REQUIRED" as const,
    whyApprovalRequired: "policy",
    proposedActions: [
      {
        stepId: "step_1",
        actionType: "LOCAL_TASK",
        description: "noop",
        targetIds: [],
      },
    ],
    targetsAffected: [],
    repositoryCommitSha: "b".repeat(40),
    repositoryFingerprint: "c".repeat(64),
    policyBundleId: "policy_test",
    policyBundleHash: "d".repeat(64),
    blastRadius: { stepCount: 1, actionTypes: ["LOCAL_TASK"], riskLevels: [] },
    verificationStrategy: ["unit"],
    rollbackContainmentStrategy: ["revert"],
    unresolvedAssumptions: [],
    approvalEligibleFindingSummaries: ["needs human"],
    capabilitySetFingerprint: "f".repeat(64),
    capabilityAuthorityScope: [],
    verificationCoverageSummary: [],
    createdAt: "2026-09-23T12:00:00.000Z",
    expiresAt: "2026-09-23T13:00:00.000Z",
  };
}
