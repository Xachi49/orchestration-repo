/**
 * Resend-backed Phase 6 delivery semantics through the local authorization stack.
 * Mocked Resend only — no real emails.
 */
import { describe, expect, it } from "vitest";
import { createLocalAuthorizationStack } from "./local-stack.js";
import {
  ResendApprovalDeliveryService,
  approvalDeliveryIdempotencyKey,
} from "./resend-approval-delivery.js";
import { exampleAdmissionRequest } from "../../admission/fixtures.js";
import { EXAMPLE_ENVIRONMENT } from "../../control-plane/fixtures.js";
import { buildServer } from "../../api/server.js";

async function validatedRun(delivery: ResendApprovalDeliveryService) {
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
  return { stack, runId };
}

describe("Resend approval delivery through Phase 6 routing", () => {
  it("delivers nonce via Resend and HTTP route response never exposes it", async () => {
    const nonceSeen: string[] = [];
    const keys: string[] = [];
    const delivery = new ResendApprovalDeliveryService({
      apiKey: "re_test",
      from: "orch@example.com",
      to: "ops@example.com",
      transport: {
        sendEmail: async (input) => {
          keys.push(input.idempotencyKey);
          const match = /Decision nonce[^\n]*\n([^\n]+)/.exec(input.text);
          if (match?.[1]) {
            nonceSeen.push(match[1]);
          }
          return { id: "email_route_1" };
        },
      },
    });
    const { stack, runId } = await validatedRun(delivery);
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
    const routed = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/authorization-route`,
    });
    expect(routed.statusCode).toBe(200);
    const body = routed.json();
    expect(body.outcome).toBe("PENDING_APPROVAL");
    expect(JSON.stringify(body)).not.toMatch(/decisionNonce(?!Hash)/);
    expect(nonceSeen).toHaveLength(1);
    expect(nonceSeen[0]!.length).toBeGreaterThan(8);
    expect(keys[0]).toBe(
      approvalDeliveryIdempotencyKey(body.approvalRequestId as string),
    );

    const pending = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/approval-request`,
    });
    expect(pending.statusCode).toBe(200);
    expect(JSON.stringify(pending.json())).not.toContain(nonceSeen[0]!);
    expect(pending.json().decisionNonceHash).toMatch(/^[a-f0-9]{64}$/);
    await app.close();
  });

  it("provider failure cancels ApprovalRequest and replacement gets new identity/nonce", async () => {
    let fail = true;
    const delivery = new ResendApprovalDeliveryService({
      apiKey: "re_test",
      from: "orch@example.com",
      to: "ops@example.com",
      transport: {
        sendEmail: async () => {
          if (fail) {
            throw new Error("provider unavailable");
          }
          return { id: "email_ok" };
        },
      },
    });
    const { stack, runId } = await validatedRun(delivery);
    await expect(stack.authorizationRouting.route(runId)).rejects.toMatchObject({
      code: "APPROVAL_DELIVERY_FAILED",
    });
    const afterFail = await stack.approvalRequests.listByRun(runId);
    expect(afterFail).toHaveLength(1);
    const requestA = afterFail[0]!;
    expect(requestA.status).toBe("CANCELLED");
    expect(requestA.deliveryFailureCode).toBe("APPROVAL_DELIVERY_FAILED");
    const hashA = requestA.decisionNonceHash;

    // Same cancelled request must not return to PENDING
    await expect(
      stack.approvalRequests.updateStatus(requestA.approvalRequestId, "PENDING"),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_IMMUTABLE" });

    fail = false;
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
    expect(requestB?.decisionNonceHash).not.toBe(hashA);
    expect(
      (await stack.approvalRequests.getById(requestA.approvalRequestId))
        ?.status,
    ).toBe("CANCELLED");
  });

  it("outbox-style retry uses the same deterministic idempotency key", async () => {
    const keys: string[] = [];
    const delivery = new ResendApprovalDeliveryService({
      apiKey: "re_test",
      from: "orch@example.com",
      to: "ops@example.com",
      transport: {
        sendEmail: async (input) => {
          keys.push(input.idempotencyKey);
          return { id: `email_${keys.length}` };
        },
      },
    });
    const { stack, runId } = await validatedRun(delivery);
    const routed = await stack.authorizationRouting.route(runId);
    expect(routed.outcome).toBe("PENDING_APPROVAL");
    if (routed.outcome !== "PENDING_APPROVAL") {
      return;
    }
    const req = await stack.approvalRequests.getById(routed.approvalRequestId);
    const card = await stack.decisionCards.get(routed.approvalRequestId);
    // Simulate outbox consumer retry of the same immutable request
    await delivery.deliverApprovalRequest({
      request: req!,
      card: card!,
      decisionNonce: "replay-nonce",
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe(
      approvalDeliveryIdempotencyKey(routed.approvalRequestId),
    );
  });
});
