import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import { registerAuthorizationRoutes } from "../api/authorize.js";
import {
  EXAMPLE_CAPABILITIES,
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import type { ValidationDecision } from "../domain/validation/index.js";
import {
  createLocalAuthorizationStack,
  type LocalAuthorizationStack,
} from "../infrastructure/authorization/local-stack.js";
import { ValidationFindingFactory } from "../validation/finding-factory.js";
import { FakeApprovalDeliveryService } from "./delivery.js";

const factory = new ValidationFindingFactory();

/**
 * Findings on the pilot v2 ValidationDecision that pre-fix Phase 5 persisted
 * as HUMAN_APPROVAL_REQUIRED after the v3 revision failed.
 */
const PILOT_V2_FINDINGS = [
  factory.create({
    validatorType: "POLICY",
    category: "policy-decision",
    severity: "WARNING",
    ruleId: "POLICY_APPROVAL_REQUIRED",
    message: "Policy requires human approval for action SEND_RECOVERY_EMAIL",
    repairable: false,
    approvalEligible: true,
    blocking: false,
  }),
  factory.create({
    validatorType: "CAPABILITY",
    category: "capability-approval",
    severity: "WARNING",
    ruleId: "CAPABILITY_APPROVAL_REQUIRED",
    message: "Capability SEND_RECOVERY_EMAIL requires human approval",
    repairable: false,
    approvalEligible: true,
    blocking: false,
  }),
  factory.create({
    validatorType: "CONTEXTUAL",
    category: "semantic-coverage",
    severity: "ERROR",
    ruleId: "PLAN_COVERAGE_GAP",
    message: "Plan does not cover SMS outreach or multiple contact attempts",
    repairable: true,
    approvalEligible: false,
    blocking: true,
  }),
  factory.create({
    validatorType: "CONTEXTUAL",
    category: "semantic-coverage",
    severity: "ERROR",
    ruleId: "ACCEPTANCE_CRITERIA_UNSATISFIED",
    message: "No step satisfies the SMS acceptance criterion",
    repairable: true,
    approvalEligible: false,
    blocking: true,
  }),
  factory.create({
    validatorType: "STATE",
    category: "revision",
    severity: "ERROR",
    ruleId: "REVISION_FAILED",
    message: "Revised plan could not be compiled",
    repairable: false,
    approvalEligible: true,
    blocking: true,
    subject: { code: "REVISION_COMPILATION_FAILED" },
    metadata: {
      code: "REVISION_COMPILATION_FAILED",
      details: { runId: "run_legacy", targetPlanVersion: 3 },
    },
  }),
];

function legacyDecisionFrom(
  decision: ValidationDecision,
  overrides: Partial<ValidationDecision> = {},
): ValidationDecision {
  return {
    ...decision,
    decision: "HUMAN_APPROVAL_REQUIRED",
    requiresHumanAction: true,
    findings: [...PILOT_V2_FINDINGS],
    ...overrides,
  };
}

/**
 * Makes the persisted record for `legacy.validationDecisionId` read back as
 * `legacy`, i.e. the content pre-fix Phase 5 would have stored under the id an
 * existing ApprovalRequest is bound to.
 */
function persistAsLegacy(
  stack: LocalAuthorizationStack,
  legacy: ValidationDecision,
): void {
  const repo = stack.validationDecisions;
  const swap = (decision: ValidationDecision | null) =>
    decision?.validationDecisionId === legacy.validationDecisionId
      ? legacy
      : decision;
  const getById = repo.getById.bind(repo);
  const getLatestByRunId = repo.getLatestByRunId.bind(repo);
  const getByPlan = repo.getByPlan.bind(repo);
  const listByRunId = repo.listByRunId.bind(repo);
  repo.getById = async (id) => swap(await getById(id));
  repo.getLatestByRunId = async (runId) => swap(await getLatestByRunId(runId));
  repo.getByPlan = async (runId, planId, planVersion) =>
    swap(await getByPlan(runId, planId, planVersion));
  repo.listByRunId = async (runId) =>
    (await listByRunId(runId)).map(
      (decision) => swap(decision) as ValidationDecision,
    );
}

const APPROVAL_REQUIRED_CAPABILITIES = EXAMPLE_CAPABILITIES.map((capability) =>
  capability.capabilityId === "CREATE_LOCAL_PATCH"
    ? { ...capability, approvalRequirement: "REQUIRED" as const }
    : capability,
);

async function validatedRun() {
  const delivery = new FakeApprovalDeliveryService();
  const stack = createLocalAuthorizationStack({
    approvalDelivery: delivery,
    capabilities: APPROVAL_REQUIRED_CAPABILITIES,
  });
  const admitted = await stack.admission.admit(exampleAdmissionRequest());
  if (admitted.outcome !== "ADMITTED") {
    throw new Error("expected ADMITTED");
  }
  const runId = admitted.runId;
  await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
  await stack.planning.plan(runId);
  const validated = await stack.validation.validate(runId);
  expect(validated.decision).toBe("HUMAN_APPROVAL_REQUIRED");
  return { stack, runId, delivery };
}

/** A PENDING request exists, then its bound decision reads back as legacy. */
async function legacyPendingRequest() {
  const { stack, runId, delivery } = await validatedRun();
  const routed = await stack.authorizationRouting.route(runId);
  if (routed.outcome !== "PENDING_APPROVAL") {
    throw new Error(`expected PENDING_APPROVAL, got ${routed.outcome}`);
  }
  const bound = await stack.validationDecisions.getById(
    routed.validationDecisionId,
  );
  persistAsLegacy(stack, legacyDecisionFrom(bound!));
  const nonce = delivery.nonceFor(routed.approvalRequestId)!;
  const card = await stack.decisionCards.get(routed.approvalRequestId);
  return {
    stack,
    runId,
    delivery,
    approvalRequestId: routed.approvalRequestId,
    nonce,
    card,
  };
}

describe("Phase 6 routing — approval eligibility", () => {
  it("refuses a legacy HUMAN_APPROVAL_REQUIRED decision with non-approval-eligible blockers", async () => {
    const { stack, runId, delivery } = await validatedRun();
    const current = await stack.validationDecisions.getLatestByRunId(runId);
    await stack.validationDecisions.save(
      legacyDecisionFrom(current!, {
        validationDecisionId: "vd_legacy_pilot_v2",
      }),
    );

    await expect(stack.authorizationRouting.route(runId)).rejects.toMatchObject({
      code: "VALIDATION_NOT_APPROVAL_ELIGIBLE",
      details: {
        validationDecisionId: "vd_legacy_pilot_v2",
        ruleIds: ["ACCEPTANCE_CRITERIA_UNSATISFIED", "PLAN_COVERAGE_GAP"],
      },
    });
    expect(await stack.approvalRequests.listByRun(runId)).toHaveLength(0);
    expect(delivery.delivered).toHaveLength(0);
    expect((await stack.runs.getById(runId))?.state).toBe("VALIDATING");
  });

  it("still routes a legitimate approval-eligible HUMAN_APPROVAL_REQUIRED decision", async () => {
    const { stack, runId } = await validatedRun();
    const routed = await stack.authorizationRouting.route(runId);
    expect(routed.outcome).toBe("PENDING_APPROVAL");
  });
});

describe("Phase 6 decide — existing pending request (pilot regression)", () => {
  it("APPROVE fails closed: no AuthorizationRecord, run not APPROVED, request stays PENDING", async () => {
    const { stack, runId, approvalRequestId, nonce, card } =
      await legacyPendingRequest();
    // The stored card predates the correction and still displays an
    // approvable decision; Phase 6 must not rely on it.
    expect(card?.validationDecision).toBe("HUMAN_APPROVAL_REQUIRED");

    await expect(
      stack.humanAuthorization.decide({
        approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: nonce,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_NOT_APPROVAL_ELIGIBLE" });

    expect(
      await stack.authorizationRecords.getByApprovalRequest(approvalRequestId),
    ).toBeNull();
    expect((await stack.runs.getById(runId))?.state).toBe("AWAITING_APPROVAL");
    expect((await stack.approvalRequests.getById(approvalRequestId))?.status).toBe(
      "PENDING",
    );
    expect(
      await stack.authorizationCoordinator.isNonceConsumed(approvalRequestId),
    ).toBe(false);
  });

  it("REJECT remains available after a refused APPROVE", async () => {
    const { stack, runId, approvalRequestId, nonce } =
      await legacyPendingRequest();
    await expect(
      stack.humanAuthorization.decide({
        approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: nonce,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_NOT_APPROVAL_ELIGIBLE" });

    const rejected = await stack.humanAuthorization.decide({
      approvalRequestId,
      approverId: "approver_bootstrap",
      decision: "REJECT",
      submittedAt: stack.clock.nowIso(),
      decisionNonce: nonce,
    });
    expect(rejected.result).toBe("REJECTED");
    expect((await stack.runs.getById(runId))?.state).toBe("REJECTED");
    const record =
      await stack.authorizationRecords.getByApprovalRequest(approvalRequestId);
    expect(record?.decision).toBe("REJECT");
  });

  it("REQUEST_MODIFICATION keeps its existing semantics", async () => {
    const { stack, runId, approvalRequestId, nonce } =
      await legacyPendingRequest();
    const result = await stack.humanAuthorization.decide({
      approvalRequestId,
      approverId: "approver_bootstrap",
      decision: "REQUEST_MODIFICATION",
      note: "Remove the SMS premise and re-plan",
      submittedAt: stack.clock.nowIso(),
      decisionNonce: nonce,
    });
    expect(result.result).toBe("MODIFICATION_REQUESTED");
    expect((await stack.runs.getById(runId))?.state).toBe("ESCALATED");
  });

  it("unreachable-delivery reissue is refused without cancelling the request", async () => {
    const { stack, approvalRequestId } = await legacyPendingRequest();
    await expect(
      stack.humanAuthorization.recoverUnreachableApprovalDelivery({
        approvalRequestId,
        reason: "DELIVERY_UNREACHABLE",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_NOT_APPROVAL_ELIGIBLE" });
    expect((await stack.approvalRequests.getById(approvalRequestId))?.status).toBe(
      "PENDING",
    );
    expect(
      await stack.authorizationCoordinator.isNonceConsumed(approvalRequestId),
    ).toBe(false);
  });

  it("a legitimate approval-eligible request still approves", async () => {
    const { stack, runId, delivery } = await validatedRun();
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected PENDING_APPROVAL");
    }
    const approved = await stack.humanAuthorization.decide({
      approvalRequestId: routed.approvalRequestId,
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      submittedAt: stack.clock.nowIso(),
      decisionNonce: delivery.nonceFor(routed.approvalRequestId)!,
    });
    expect(approved.result).toBe("APPROVED");
    expect((await stack.runs.getById(runId))?.state).toBe("APPROVED");
  });

  it("HTTP APPROVE returns 409 without leaking nonce or finding text", async () => {
    const { stack, approvalRequestId, nonce } = await legacyPendingRequest();
    const app = Fastify();
    registerAuthorizationRoutes(app, {
      routing: stack.authorizationRouting,
      humanAuthorization: stack.humanAuthorization,
      expiry: stack.approvalExpiry,
      readiness: stack.authorizationReadiness,
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/approval-requests/${approvalRequestId}/decision`,
      payload: {
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: nonce,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "VALIDATION_NOT_APPROVAL_ELIGIBLE",
      message:
        "Validation decision has unresolved blocking findings that are not approval-eligible",
    });
    expect(response.body).not.toContain(nonce);
    expect(response.body).not.toContain("SMS");
    await app.close();
  });
});
