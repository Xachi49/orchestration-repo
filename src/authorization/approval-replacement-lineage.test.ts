/**
 * ApprovalRequest replacement lineage read model.
 * READ MODEL != AUTHORITY; LINEAGE DISCOVERY != REISSUE.
 */
import { describe, expect, it, vi } from "vitest";
import { createLocalAuthorizationStack } from "../infrastructure/authorization/local-stack.js";
import { FakeApprovalDeliveryService } from "./delivery.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { buildServer } from "../api/server.js";
import { FakeRequestAuthenticator } from "../runtime/auth.js";
import { InMemoryProjectAccessDirectory } from "../runtime/access.js";
import { DrainController } from "../runtime/startup.js";
import { OperationalMetrics } from "../runtime/metrics.js";
import { MemoryStructuredLogger } from "../runtime/logging.js";
import { SlidingWindowRateLimiter } from "../runtime/rate-limit.js";
import { parseApprovalRequest } from "../domain/authorization/index.js";
import { InMemoryApprovalRequestRepository } from "./approval-request-repository.js";
import { APPROVAL_REPLACEMENT_LINEAGE_SCOPE } from "./replacement-lineage.js";
import { APPROVAL_DELIVERY_UNREACHABLE_REASON } from "./service.js";

async function awaitingApproval() {
  const delivery = new FakeApprovalDeliveryService();
  const stack = createLocalAuthorizationStack({ approvalDelivery: delivery });
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
    delivery,
    runId,
    approvalRequestId: routed.approvalRequestId,
  };
}

function perimeter(principalId: string, projectIds: readonly string[]) {
  return {
    authenticator: new FakeRequestAuthenticator({
      principalId,
      authenticationMode: "HEADER_PRINCIPAL" as const,
    }),
    access: new InMemoryProjectAccessDirectory([{ principalId, projectIds }]),
    drain: new DrainController(),
    metrics: new OperationalMetrics(),
    logger: new MemoryStructuredLogger("lineage", () => undefined),
    rateLimiter: new SlidingWindowRateLimiter(60, 60_000),
    authenticationMode: "HEADER_PRINCIPAL" as const,
  };
}

describe("listApprovalReplacements / GET replacements", () => {
  it("1: returns cancelled replacement after failed reissue delivery", async () => {
    const gated = new FakeApprovalDeliveryService();
    const stack = createLocalAuthorizationStack({ approvalDelivery: gated });
    const admitted = await stack.admission.admit(exampleAdmissionRequest());
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
      throw new Error("expected PENDING");
    }
    const approvalRequestId = routed.approvalRequestId;

    gated.setFailAlways(true);
    await expect(
      stack.humanAuthorization.recoverUnreachableApprovalDelivery({
        approvalRequestId,
        reason: "DELIVERY_UNREACHABLE",
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_DELIVERY_FAILED" });

    const lineage =
      await stack.humanAuthorization.listApprovalReplacements(approvalRequestId);
    expect(lineage.originalApprovalRequestId).toBe(approvalRequestId);
    expect(lineage.lineageScope).toBe(APPROVAL_REPLACEMENT_LINEAGE_SCOPE);
    expect(lineage.replacements).toHaveLength(1);
    expect(lineage.replacements[0]?.status).toBe("CANCELLED");
    expect(lineage.replacements[0]?.replacesApprovalRequestId).toBe(
      approvalRequestId,
    );
    expect(lineage.replacements[0]?.deliveryFailureCode).toBe(
      "APPROVAL_DELIVERY_FAILED",
    );
    expect(
      (await stack.approvalRequests.getById(approvalRequestId))
        ?.failureReasonCode,
    ).toBe(APPROVAL_DELIVERY_UNREACHABLE_REASON);
  });

  it("2: returns PENDING replacement after successful reissue", async () => {
    const { stack, approvalRequestId } = await awaitingApproval();
    const result =
      await stack.humanAuthorization.recoverUnreachableApprovalDelivery({
        approvalRequestId,
        reason: "DELIVERY_UNREACHABLE",
      });
    expect(result.outcome).toBe("REISSUED");
    if (result.outcome !== "REISSUED") return;

    const lineage =
      await stack.humanAuthorization.listApprovalReplacements(approvalRequestId);
    expect(lineage.replacements).toHaveLength(1);
    expect(lineage.replacements[0]?.approvalRequestId).toBe(
      result.replacementApprovalRequestId,
    );
    expect(lineage.replacements[0]?.status).toBe("PENDING");
  });

  it("3–4: multiple direct replacements ordered by createdAt; unrelated excluded", async () => {
    const repo = new InMemoryApprovalRequestRepository();
    const base = {
      runId: "run_lineage",
      projectId: EXAMPLE_PROJECT_ID,
      objectiveId: "obj_1",
      objectiveVersion: 1 as const,
      planId: "plan_1",
      planVersion: 1 as const,
      planHash: "aa".repeat(32),
      repositoryCommitSha: "bb".repeat(20),
      repositoryFingerprint: "cc".repeat(32),
      policyBundleId: "pol_1",
      policyBundleHash: "dd".repeat(32),
      validationDecisionId: "vd_1",
      validationDecision: "HUMAN_APPROVAL_REQUIRED" as const,
      requestReason: "HUMAN_APPROVAL_REQUIRED" as const,
      requestedApproverIds: ["approver_bootstrap"],
      expiresAt: "2026-09-24T02:00:00.000Z",
      decisionCardHash: "ee".repeat(32),
      capabilitySetFingerprint: "ff".repeat(32),
      decisionNonceHash: "11".repeat(32),
    };
    await repo.save(
      parseApprovalRequest({
        ...base,
        approvalRequestId: "apr_original",
        createdAt: "2026-09-24T00:00:00.000Z",
        status: "CANCELLED",
        failureReasonCode: APPROVAL_DELIVERY_UNREACHABLE_REASON,
      }),
    );
    await repo.save(
      parseApprovalRequest({
        ...base,
        approvalRequestId: "apr_child_b",
        createdAt: "2026-09-24T00:02:00.000Z",
        status: "CANCELLED",
        replacesApprovalRequestId: "apr_original",
        deliveryFailureCode: "APPROVAL_DELIVERY_FAILED",
      }),
    );
    await repo.save(
      parseApprovalRequest({
        ...base,
        approvalRequestId: "apr_child_a",
        createdAt: "2026-09-24T00:01:00.000Z",
        status: "CANCELLED",
        replacesApprovalRequestId: "apr_original",
        deliveryFailureCode: "APPROVAL_DELIVERY_FAILED",
      }),
    );
    await repo.save(
      parseApprovalRequest({
        ...base,
        approvalRequestId: "apr_unrelated",
        runId: "run_other",
        createdAt: "2026-09-24T00:01:30.000Z",
        status: "CANCELLED",
        replacesApprovalRequestId: "apr_someone_else",
      }),
    );
    // Grandchild — not a direct child of original.
    await repo.save(
      parseApprovalRequest({
        ...base,
        approvalRequestId: "apr_grandchild",
        createdAt: "2026-09-24T00:03:00.000Z",
        status: "PENDING",
        replacesApprovalRequestId: "apr_child_b",
      }),
    );

    const children = await repo.listByReplacesApprovalRequestId("apr_original");
    expect(children.map((c) => c.approvalRequestId)).toEqual([
      "apr_child_a",
      "apr_child_b",
    ]);
    expect(children.every((c) => c.approvalRequestId !== "apr_unrelated")).toBe(
      true,
    );
    expect(
      children.every((c) => c.approvalRequestId !== "apr_grandchild"),
    ).toBe(true);
  });

  it("5: HTTP response never exposes nonce/hash/ciphertext", async () => {
    const { stack, approvalRequestId, delivery } = await awaitingApproval();
    const nonce = delivery.nonceFor(approvalRequestId)!;
    await stack.humanAuthorization.recoverUnreachableApprovalDelivery({
      approvalRequestId,
      reason: "DELIVERY_UNREACHABLE",
    });
    const app = await buildServer({
      admission: stack.admission,
      ingestion: stack.ingestion,
      planning: stack.planning,
      validation: stack.validation,
      authorizationRouting: stack.authorizationRouting,
      humanAuthorization: stack.humanAuthorization,
      approvalExpiry: stack.approvalExpiry,
      authorizationReadiness: stack.authorizationReadiness,
    });
    const res = await app.inject({
      method: "GET",
      url: `/v1/approval-requests/${approvalRequestId}/replacements`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const text = res.body;
    expect(body.lineageScope).toBe("DIRECT");
    expect(text).not.toContain(nonce);
    expect(text).not.toMatch(/decisionNonceHash/);
    expect(text).not.toMatch(/ciphertext|deliverySecret|apiKey/i);
    expect(body.replacements[0]).not.toHaveProperty("decisionNonceHash");
    expect(body.replacements[0]).not.toHaveProperty("decisionCardHash");
    await app.close();
  });

  it("6: unauthorized project access is denied by perimeter", async () => {
    const { stack, approvalRequestId } = await awaitingApproval();
    await stack.humanAuthorization.recoverUnreachableApprovalDelivery({
      approvalRequestId,
      reason: "DELIVERY_UNREACHABLE",
    });

    const outsider = perimeter("outsider", ["other-project"]);
    const app = await buildServer({
      admission: stack.admission,
      humanAuthorization: stack.humanAuthorization,
      authorizationRouting: stack.authorizationRouting,
      approvalExpiry: stack.approvalExpiry,
      authorizationReadiness: stack.authorizationReadiness,
      runs: stack.runs,
      perimeter: {
        ...outsider,
        approvalRequests: stack.approvalRequests,
        runs: stack.runs,
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/v1/approval-requests/${approvalRequestId}/replacements`,
      headers: { "x-orchestrator-principal": "outsider" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("PROJECT_ACCESS_DENIED");
    await app.close();
  });

  it("7: endpoint is strictly read-only", async () => {
    const { stack, approvalRequestId, runId } = await awaitingApproval();
    await stack.humanAuthorization.recoverUnreachableApprovalDelivery({
      approvalRequestId,
      reason: "DELIVERY_UNREACHABLE",
    });
    const before = await stack.approvalRequests.listByRun(runId);
    const updateSpy = vi.spyOn(stack.approvalRequests, "updateStatus");

    const app = await buildServer({
      humanAuthorization: stack.humanAuthorization,
      authorizationRouting: stack.authorizationRouting,
      approvalExpiry: stack.approvalExpiry,
      authorizationReadiness: stack.authorizationReadiness,
    });
    const first = await app.inject({
      method: "GET",
      url: `/v1/approval-requests/${approvalRequestId}/replacements`,
    });
    const second = await app.inject({
      method: "GET",
      url: `/v1/approval-requests/${approvalRequestId}/replacements`,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toEqual(second.json());
    expect(updateSpy).not.toHaveBeenCalled();
    const after = await stack.approvalRequests.listByRun(runId);
    expect(after).toEqual(before);
    expect(await stack.authorizationRecords.getLatestByRun(runId)).toBeNull();
    updateSpy.mockRestore();
    await app.close();
  });

  it("8: existing pending approval read remains unchanged", async () => {
    const { stack, approvalRequestId, runId } = await awaitingApproval();
    const app = await buildServer({
      humanAuthorization: stack.humanAuthorization,
      authorizationRouting: stack.authorizationRouting,
      approvalExpiry: stack.approvalExpiry,
      authorizationReadiness: stack.authorizationReadiness,
    });
    const pending = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/approval-request`,
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().approvalRequestId).toBe(approvalRequestId);
    expect(pending.json()).toHaveProperty("decisionNonceHash");
    await app.close();
  });
});
