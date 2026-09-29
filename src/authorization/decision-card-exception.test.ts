import { describe, expect, it } from "vitest";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_CAPABILITIES,
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import type {
  ValidationDecision,
  ValidationFinding,
} from "../domain/validation/index.js";
import { createLocalAuthorizationStack } from "../infrastructure/authorization/local-stack.js";
import { buildApprovalDeliveryEmailText } from "../infrastructure/authorization/resend-approval-delivery.js";
import { ValidationFindingFactory } from "../validation/finding-factory.js";
import { planningExceptionSummaryFromDecision } from "../validation/exception.js";
import { FakeApprovalDeliveryService } from "./delivery.js";

const factory = new ValidationFindingFactory();
const CUSTOMER_EMAIL = "alex@example.com";

function revisionFailedFinding(
  metadata: Record<string, unknown>,
): ValidationFinding {
  return factory.create({
    validatorType: "STATE",
    category: "revision",
    severity: "ERROR",
    ruleId: "REVISION_FAILED",
    message: "Revised plan failed recovery target binding: MODEL_TARGET_CONFLICT",
    repairable: false,
    approvalEligible: true,
    blocking: true,
    subject: { code: "REVISION_COMPILATION_FAILED" },
    metadata,
  });
}

/**
 * Routes an approval-eligible HUMAN_APPROVAL_REQUIRED decision whose persisted
 * findings carry a REVISION_FAILED exception.
 */
async function routedWithRevisionFailure(failure: ValidationFinding) {
  const delivery = new FakeApprovalDeliveryService();
  const stack = createLocalAuthorizationStack({
    approvalDelivery: delivery,
    capabilities: EXAMPLE_CAPABILITIES.map((capability) =>
      capability.capabilityId === "CREATE_LOCAL_PATCH"
        ? { ...capability, approvalRequirement: "REQUIRED" as const }
        : capability,
    ),
  });
  const admitted = await stack.admission.admit(exampleAdmissionRequest());
  if (admitted.outcome !== "ADMITTED") {
    throw new Error("expected ADMITTED");
  }
  const runId = admitted.runId;
  await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
  await stack.planning.plan(runId);
  await stack.validation.validate(runId);
  const current = (await stack.validationDecisions.getLatestByRunId(runId))!;
  const withException: ValidationDecision = {
    ...current,
    validationDecisionId: "vd_revision_failed",
    findings: [...current.findings, failure],
  };
  await stack.validationDecisions.save(withException);
  const routed = await stack.authorizationRouting.route(runId);
  if (routed.outcome !== "PENDING_APPROVAL") {
    throw new Error(`expected PENDING_APPROVAL, got ${routed.outcome}`);
  }
  const card = (await stack.decisionCards.get(routed.approvalRequestId))!;
  const request = (await stack.approvalRequests.getById(
    routed.approvalRequestId,
  ))!;
  const nonce = delivery.nonceFor(routed.approvalRequestId)!;
  return { stack, card, request, nonce, decision: withException };
}

describe("DecisionCard planningExceptionSummary", () => {
  it("is built from the persisted revision-failure finding", async () => {
    const { card } = await routedWithRevisionFailure(
      revisionFailedFinding({
        code: "REVISION_COMPILATION_FAILED",
        causeClass: "RECOVERY_TARGET_BINDING",
        causeCode: "MODEL_TARGET_CONFLICT",
        binderCode: "MODEL_TARGET_CONFLICT",
        details: { runId: "run_x", targetPlanVersion: 3 },
      }),
    );
    expect(card.planningExceptionSummary).toEqual({
      exceptionId: "pex_vd_revision_failed",
      exceptionType: "REVISION_FAILED",
      message: "Automated validation stopped: REVISION_FAILED",
      reasonCodes: ["REVISION_FAILED", "REVISION_COMPILATION_FAILED"],
      causeClass: "RECOVERY_TARGET_BINDING",
      causeCode: "MODEL_TARGET_CONFLICT",
    });
  });

  it("summarizes legacy findings that predate cause classification", () => {
    const summary = planningExceptionSummaryFromDecision({
      validationDecisionId: "vd_legacy",
      findings: [
        revisionFailedFinding({
          code: "REVISION_COMPILATION_FAILED",
          details: { runId: "run_x", targetPlanVersion: 3 },
        }),
      ],
    } as unknown as ValidationDecision);
    expect(summary).toEqual({
      exceptionId: "pex_vd_legacy",
      exceptionType: "REVISION_FAILED",
      message: "Automated validation stopped: REVISION_FAILED",
      reasonCodes: ["REVISION_FAILED", "REVISION_COMPILATION_FAILED"],
    });
  });

  it("drops unsafe cause values", () => {
    const summary = planningExceptionSummaryFromDecision({
      validationDecisionId: "vd_unsafe",
      findings: [
        revisionFailedFinding({
          code: `Error: ${CUSTOMER_EMAIL}`,
          causeClass: "ARBITRARY_CLASS",
          causeCode: CUSTOMER_EMAIL,
          stack: "Error\n    at x (/app/y.js:1:1)",
        }),
      ],
    } as unknown as ValidationDecision);
    expect(summary).toEqual({
      exceptionId: "pex_vd_unsafe",
      exceptionType: "REVISION_FAILED",
      message: "Automated validation stopped: REVISION_FAILED",
      reasonCodes: ["REVISION_FAILED"],
    });
  });

  it("is absent when the decision carries no planning exception", async () => {
    const delivery = new FakeApprovalDeliveryService();
    const stack = createLocalAuthorizationStack({ approvalDelivery: delivery });
    const admitted = await stack.admission.admit(exampleAdmissionRequest());
    if (admitted.outcome !== "ADMITTED") {
      throw new Error("expected ADMITTED");
    }
    const runId = admitted.runId;
    await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    await stack.planning.plan(runId);
    await stack.validation.validate(runId);
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error("expected PENDING_APPROVAL");
    }
    const card = await stack.decisionCards.get(routed.approvalRequestId);
    expect(card).not.toHaveProperty("planningExceptionSummary");
  });

  it("card and approval email stay free of nonce, stack traces, and customer data", async () => {
    const { card, request, nonce } = await routedWithRevisionFailure(
      revisionFailedFinding({
        code: "REVISION_COMPILATION_FAILED",
        causeClass: "INFRASTRUCTURE",
        causeCode: "ECONNRESET",
        details: {},
      }),
    );
    const cardJson = JSON.stringify(card);
    expect(cardJson).not.toContain(nonce);
    expect(cardJson).not.toContain(CUSTOMER_EMAIL);
    expect(cardJson).not.toContain(" at ");

    const email = buildApprovalDeliveryEmailText({
      request,
      card,
      decisionNonce: nonce,
    });
    expect(email).toContain("Planning exception:");
    expect(email).toContain(
      "REVISION_FAILED (REVISION_FAILED, REVISION_COMPILATION_FAILED) cause=INFRASTRUCTURE/ECONNRESET",
    );
  });
});
