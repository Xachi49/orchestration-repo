/**
 * Unreachable-delivery approval recovery.
 * LOST DELIVERY != AUTHORIZATION; REISSUE != APPROVAL.
 */
import { describe, expect, it } from "vitest";
import { createLocalAuthorizationStack } from "../infrastructure/authorization/local-stack.js";
import { FakeApprovalDeliveryService } from "./delivery.js";
import { hashDecisionNonce } from "./decision-card-hasher.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import { EXAMPLE_ENVIRONMENT } from "../control-plane/fixtures.js";
import { buildServer } from "../api/server.js";
import { InMemoryEventStore } from "../infrastructure/admission/in-memory-event-store.js";
import {
  APPROVAL_DELIVERY_UNREACHABLE_REASON,
  APPROVAL_REISSUE_AUDIT_EVENT,
  HumanAuthorizationService,
} from "./service.js";

async function awaitingApproval(options?: {
  delivery?: FakeApprovalDeliveryService;
}) {
  const delivery = options?.delivery ?? new FakeApprovalDeliveryService();
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

function nonceFor(
  delivery: FakeApprovalDeliveryService,
  approvalRequestId: string,
): string {
  const nonce = delivery.nonceFor(approvalRequestId);
  if (!nonce) {
    throw new Error(`missing nonce for ${approvalRequestId}`);
  }
  return nonce;
}

describe("recoverUnreachableApprovalDelivery", () => {
  it("reissues PENDING + AWAITING_APPROVAL for DELIVERY_UNREACHABLE", async () => {
    const { stack, delivery, runId, approvalRequestId } =
      await awaitingApproval();
    const original = await stack.approvalRequests.getById(approvalRequestId);
    const oldNonce = nonceFor(delivery, approvalRequestId);
    const oldHash = original!.decisionNonceHash;

    const result =
      await stack.humanAuthorization.recoverUnreachableApprovalDelivery({
        approvalRequestId,
        reason: "DELIVERY_UNREACHABLE",
        operatorPrincipalId: "operator_static",
      });

    expect(result.outcome).toBe("REISSUED");
    if (result.outcome !== "REISSUED") return;
    expect(result.runId).toBe(runId);
    expect(result.originalApprovalRequestId).toBe(approvalRequestId);
    expect(result.replacementApprovalRequestId).not.toBe(approvalRequestId);
    expect(result.replacesApprovalRequestId).toBe(approvalRequestId);
    expect(result.runState).toBe("AWAITING_APPROVAL");
    expect(JSON.stringify(result)).not.toContain(oldNonce);
    expect(JSON.stringify(result)).not.toContain("decisionNonce");

    const cancelled = await stack.approvalRequests.getById(approvalRequestId);
    expect(cancelled?.status).toBe("CANCELLED");
    expect(cancelled?.failureReasonCode).toBe(
      APPROVAL_DELIVERY_UNREACHABLE_REASON,
    );

    await expect(
      stack.humanAuthorization.decide({
        approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: oldNonce,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_NOT_PENDING" });

    const replacement = await stack.approvalRequests.getById(
      result.replacementApprovalRequestId,
    );
    expect(replacement?.status).toBe("PENDING");
    expect(replacement?.replacesApprovalRequestId).toBe(approvalRequestId);
    expect(replacement?.decisionNonceHash).not.toBe(oldHash);
    expect(replacement?.planId).toBe(original!.planId);
    expect(replacement?.planVersion).toBe(original!.planVersion);
    expect(replacement?.planHash).toBe(original!.planHash);
    expect(replacement?.validationDecisionId).toBe(
      original!.validationDecisionId,
    );
    expect(replacement?.policyBundleHash).toBe(original!.policyBundleHash);
    expect(replacement?.repositoryFingerprint).toBe(
      original!.repositoryFingerprint,
    );
    expect(replacement?.capabilitySetFingerprint).toBe(
      original!.capabilitySetFingerprint,
    );
    expect(replacement?.requestedApproverIds).toEqual(
      original!.requestedApproverIds,
    );
    // DecisionCardHasher excludes createdAt/expiresAt — when authority bindings
    // are unchanged the decisionCardHash may remain identical. New identity is
    // still enforced via approvalRequestId + decisionNonceHash.
    expect(replacement?.decisionCardHash).toMatch(/^[a-f0-9]{64}$/);

    const newNonce = nonceFor(delivery, result.replacementApprovalRequestId);
    expect(newNonce).not.toBe(oldNonce);
    expect(hashDecisionNonce(newNonce)).toBe(replacement!.decisionNonceHash);

    expect((await stack.runs.getById(runId))?.state).toBe("AWAITING_APPROVAL");
  });

  it("repeated recovery returns ALREADY_REISSUED without a second replacement", async () => {
    const { stack, approvalRequestId } = await awaitingApproval();
    const first =
      await stack.humanAuthorization.recoverUnreachableApprovalDelivery({
        approvalRequestId,
        reason: "DELIVERY_UNREACHABLE",
      });
    expect(first.outcome).toBe("REISSUED");
    const second =
      await stack.humanAuthorization.recoverUnreachableApprovalDelivery({
        approvalRequestId,
        reason: "DELIVERY_UNREACHABLE",
      });
    expect(second.outcome).toBe("ALREADY_REISSUED");
    if (first.outcome !== "REISSUED" || second.outcome !== "ALREADY_REISSUED") {
      return;
    }
    expect(second.replacementApprovalRequestId).toBe(
      first.replacementApprovalRequestId,
    );
    const pending = (
      await stack.approvalRequests.listByRun(first.runId)
    ).filter((r) => r.status === "PENDING");
    expect(pending).toHaveLength(1);
  });

  it("concurrent recovery converges on one replacement", async () => {
    const { stack, approvalRequestId } = await awaitingApproval();
    const [a, b] = await Promise.all([
      stack.humanAuthorization.recoverUnreachableApprovalDelivery({
        approvalRequestId,
        reason: "DELIVERY_UNREACHABLE",
      }),
      stack.humanAuthorization.recoverUnreachableApprovalDelivery({
        approvalRequestId,
        reason: "DELIVERY_UNREACHABLE",
      }),
    ]);
    const ids = new Set(
      [a, b].map((r) =>
        r.outcome === "REISSUED" || r.outcome === "ALREADY_REISSUED"
          ? r.replacementApprovalRequestId
          : "",
      ),
    );
    expect(ids.size).toBe(1);
    const pending = (
      await stack.approvalRequests.listByRun(
        a.outcome === "REISSUED" || a.outcome === "ALREADY_REISSUED"
          ? a.runId
          : "",
      )
    ).filter((r) => r.status === "PENDING");
    expect(pending).toHaveLength(1);
  });

  it("rejects APPROVED and REJECTED requests", async () => {
    const approved = await awaitingApproval();
    await stackDecide(
      approved.stack,
      approved.approvalRequestId,
      approved.delivery,
      "APPROVE",
    );
    await expect(
      approved.stack.humanAuthorization.recoverUnreachableApprovalDelivery({
        approvalRequestId: approved.approvalRequestId,
        reason: "DELIVERY_UNREACHABLE",
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REISSUE_NOT_ELIGIBLE" });

    const rejected = await awaitingApproval();
    await stackDecide(
      rejected.stack,
      rejected.approvalRequestId,
      rejected.delivery,
      "REJECT",
    );
    await expect(
      rejected.stack.humanAuthorization.recoverUnreachableApprovalDelivery({
        approvalRequestId: rejected.approvalRequestId,
        reason: "DELIVERY_UNREACHABLE",
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REISSUE_NOT_ELIGIBLE" });
  });

  it("rejects expired PENDING requests", async () => {
    const delivery = new FakeApprovalDeliveryService();
    const stack = createLocalAuthorizationStack({
      approvalDelivery: delivery,
      approvalWindowMs: 0,
    });
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
    if (routed.outcome !== "PENDING_APPROVAL") return;
    await expect(
      stack.humanAuthorization.recoverUnreachableApprovalDelivery({
        approvalRequestId: routed.approvalRequestId,
        reason: "DELIVERY_UNREACHABLE",
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_EXPIRED" });
  });

  it("rejects when an AuthorizationRecord already exists", async () => {
    const { stack, delivery, approvalRequestId } = await awaitingApproval();
    await stackDecide(stack, approvalRequestId, delivery, "APPROVE");
    // Force status back is impossible; use a fresh PENDING and inject a record
    // via decide path already APPROVED above — recreate and append record on PENDING.
    const second = await awaitingApproval();
    const pending = await second.stack.approvalRequests.getById(
      second.approvalRequestId,
    );
    await second.stack.authorizationRecords.append({
      authorizationRecordId: "authz_injected",
      approvalRequestId: pending!.approvalRequestId,
      runId: pending!.runId,
      projectId: pending!.projectId,
      objectiveId: pending!.objectiveId,
      objectiveVersion: pending!.objectiveVersion,
      planId: pending!.planId,
      planVersion: pending!.planVersion,
      planHash: pending!.planHash,
      repositoryFingerprint: pending!.repositoryFingerprint,
      policyBundleHash: pending!.policyBundleHash,
      validationDecisionId: pending!.validationDecisionId,
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      decisionTimestamp: second.stack.clock.nowIso(),
      decisionCardHash: pending!.decisionCardHash,
      capabilitySetFingerprint: pending!.capabilitySetFingerprint,
      nonceHash: pending!.decisionNonceHash,
      createdAt: second.stack.clock.nowIso(),
    });
    await expect(
      second.stack.humanAuthorization.recoverUnreachableApprovalDelivery({
        approvalRequestId: second.approvalRequestId,
        reason: "DELIVERY_UNREACHABLE",
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_ALREADY_DECIDED" });
  });

  it("provider failure leaves no usable authority; original stays terminal", async () => {
    const delivery = new FakeApprovalDeliveryService();
    const { stack, approvalRequestId, runId } = await awaitingApproval({
      delivery,
    });
    const oldNonce = nonceFor(delivery, approvalRequestId);
    delivery.setFailAlways(true);
    await expect(
      stack.humanAuthorization.recoverUnreachableApprovalDelivery({
        approvalRequestId,
        reason: "DELIVERY_UNREACHABLE",
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_DELIVERY_FAILED" });

    const original = await stack.approvalRequests.getById(approvalRequestId);
    expect(original?.status).toBe("CANCELLED");
    expect(original?.failureReasonCode).toBe(
      APPROVAL_DELIVERY_UNREACHABLE_REASON,
    );
    expect((await stack.runs.getById(runId))?.state).toBe("AWAITING_APPROVAL");
    expect(await stack.approvalRequests.getPendingByRun(runId)).toBeNull();

    await expect(
      stack.humanAuthorization.decide({
        approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: oldNonce,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_NOT_PENDING" });

    const cancelledReplacements = (
      await stack.approvalRequests.listByRun(runId)
    ).filter(
      (r) =>
        r.replacesApprovalRequestId === approvalRequestId &&
        r.status === "CANCELLED",
    );
    expect(cancelledReplacements.length).toBeGreaterThanOrEqual(1);
  });

  it("HTTP reissue never returns nonce/hash and Fake receives replacement nonce", async () => {
    const delivery = new FakeApprovalDeliveryService();
    const { stack, approvalRequestId } = await awaitingApproval({ delivery });
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
      method: "POST",
      url: `/v1/approval-requests/${approvalRequestId}/reissue`,
      payload: { reason: "DELIVERY_UNREACHABLE" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.outcome).toBe("REISSUED");
    expect(JSON.stringify(body)).not.toMatch(/decisionNonce/);
    expect(body).not.toHaveProperty("decisionNonceHash");
    const replacementId = body.replacementApprovalRequestId as string;
    expect(delivery.nonceFor(replacementId)).toBeTruthy();
    await app.close();
  });

  it("does not alter RECOVERY_PROVIDER_MODE env", async () => {
    const prior = process.env["RECOVERY_PROVIDER_MODE"];
    process.env["RECOVERY_PROVIDER_MODE"] = "SHADOW";
    const { stack, approvalRequestId } = await awaitingApproval();
    await stack.humanAuthorization.recoverUnreachableApprovalDelivery({
      approvalRequestId,
      reason: "DELIVERY_UNREACHABLE",
    });
    expect(process.env["RECOVERY_PROVIDER_MODE"]).toBe("SHADOW");
    if (prior === undefined) {
      delete process.env["RECOVERY_PROVIDER_MODE"];
    } else {
      process.env["RECOVERY_PROVIDER_MODE"] = prior;
    }
  });

  it("Phase 7 still requires a valid APPROVE AuthorizationRecord", async () => {
    const { stack, delivery, approvalRequestId, runId } =
      await awaitingApproval();
    const recovered =
      await stack.humanAuthorization.recoverUnreachableApprovalDelivery({
        approvalRequestId,
        reason: "DELIVERY_UNREACHABLE",
      });
    expect(recovered.outcome).toBe("REISSUED");
    if (recovered.outcome !== "REISSUED") return;
    // Reissue alone does not authorize execution.
    expect(await stack.authorizationRecords.getLatestByRun(runId)).toBeNull();
    expect((await stack.runs.getById(runId))?.state).toBe("AWAITING_APPROVAL");

    const approved = await stack.humanAuthorization.decide({
      approvalRequestId: recovered.replacementApprovalRequestId,
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      submittedAt: stack.clock.nowIso(),
      decisionNonce: nonceFor(delivery, recovered.replacementApprovalRequestId),
    });
    expect(approved.result).toBe("APPROVED");
    expect(
      (await stack.authorizationRecords.getLatestByRun(runId))?.decision,
    ).toBe("APPROVE");
  });

  it("appends a non-secret reissue audit event when EventStore is wired", async () => {
    const delivery = new FakeApprovalDeliveryService();
    const base = createLocalAuthorizationStack({ approvalDelivery: delivery });
    const events = new InMemoryEventStore();
    // Rebuild humanAuthorization with events for audit coverage.
    const humanAuthorization = new HumanAuthorizationService({
      runs: base.runs,
      objectives: base.objectives,
      controlPlane: base.controlPlane,
      plans: base.plans,
      decisions: base.validationDecisions,
      locks: base.locks,
      requests: base.approvalRequests,
      records: base.authorizationRecords,
      modifications: base.modificationRequests,
      cards: base.decisionCards,
      coordinator: base.authorizationCoordinator,
      approvers: base.approverAuthorization,
      clock: base.clock,
      delivery,
      identities: base.authorizationIdentities,
      nonceGenerator: base.decisionNonceGenerator,
      events,
    });
    const admitted = await base.admission.admit(exampleAdmissionRequest());
    const runId = admitted.runId!;
    await base.ingestion.ingest(
      runId,
      exampleAdmissionRequest().projectId,
      EXAMPLE_ENVIRONMENT,
    );
    await base.planning.plan(runId);
    await base.validation.validate(runId);
    const routed = await base.authorizationRouting.route(runId);
    expect(routed.outcome).toBe("PENDING_APPROVAL");
    if (routed.outcome !== "PENDING_APPROVAL") return;

    await humanAuthorization.recoverUnreachableApprovalDelivery({
      approvalRequestId: routed.approvalRequestId,
      reason: "DELIVERY_UNREACHABLE",
      operatorPrincipalId: "operator_static",
    });
    const audit = (await events.listByRunId(runId)).filter(
      (e) => e.eventType === APPROVAL_REISSUE_AUDIT_EVENT,
    );
    expect(audit).toHaveLength(1);
    const data = audit[0]!.data as Record<string, unknown>;
    expect(data["originalApprovalRequestId"]).toBe(routed.approvalRequestId);
    expect(data["operatorPrincipalId"]).toBe("operator_static");
    expect(JSON.stringify(data)).not.toMatch(/decisionNonce|ciphertext/i);
  });
});

async function stackDecide(
  stack: ReturnType<typeof createLocalAuthorizationStack>,
  approvalRequestId: string,
  delivery: FakeApprovalDeliveryService,
  decision: "APPROVE" | "REJECT",
) {
  await stack.humanAuthorization.decide({
    approvalRequestId,
    approverId: "approver_bootstrap",
    decision,
    submittedAt: stack.clock.nowIso(),
    decisionNonce: nonceFor(delivery, approvalRequestId),
  });
}
