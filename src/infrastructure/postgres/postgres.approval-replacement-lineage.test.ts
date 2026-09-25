/**
 * Postgres ApprovalRequest replacement lineage query.
 * READ MODEL != AUTHORITY.
 */
import { describe, expect, it } from "vitest";
import {
  createTestStack,
  uniquePostgresTestId,
} from "./test-helpers.js";
import { parseApprovalRequest } from "../../domain/authorization/index.js";
import { EXAMPLE_PROJECT_ID } from "../../control-plane/fixtures.js";

describe("PostgreSQL approval replacement lineage", () => {
  it("listByReplacesApprovalRequestId returns direct children ordered by createdAt", async () => {
    const instanceId = uniquePostgresTestId("approval_replacement_lineage");
    const env = await createTestStack(instanceId);
    try {
      const base = {
        runId: `run_${instanceId}`,
        projectId: EXAMPLE_PROJECT_ID,
        objectiveId: "obj_lineage",
        objectiveVersion: 1 as const,
        planId: "plan_lineage",
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
      const originalId = `apr_orig_${instanceId}`;
      await env.stack.approvalRequests.save(
        parseApprovalRequest({
          ...base,
          approvalRequestId: originalId,
          createdAt: "2026-09-24T00:00:00.000Z",
          status: "CANCELLED",
        }),
      );
      await env.stack.approvalRequests.save(
        parseApprovalRequest({
          ...base,
          approvalRequestId: `apr_later_${instanceId}`,
          createdAt: "2026-09-24T00:02:00.000Z",
          status: "CANCELLED",
          replacesApprovalRequestId: originalId,
          deliveryFailureCode: "APPROVAL_DELIVERY_FAILED",
        }),
      );
      await env.stack.approvalRequests.save(
        parseApprovalRequest({
          ...base,
          approvalRequestId: `apr_earlier_${instanceId}`,
          createdAt: "2026-09-24T00:01:00.000Z",
          status: "PENDING",
          replacesApprovalRequestId: originalId,
        }),
      );
      await env.stack.approvalRequests.save(
        parseApprovalRequest({
          ...base,
          approvalRequestId: `apr_other_${instanceId}`,
          createdAt: "2026-09-24T00:01:30.000Z",
          status: "CANCELLED",
          replacesApprovalRequestId: "apr_unrelated_parent",
        }),
      );

      const children =
        await env.stack.approvalRequests.listByReplacesApprovalRequestId(
          originalId,
        );
      expect(children.map((c) => c.approvalRequestId)).toEqual([
        `apr_earlier_${instanceId}`,
        `apr_later_${instanceId}`,
      ]);
      expect(children[0]?.status).toBe("PENDING");
      expect(children[1]?.deliveryFailureCode).toBe("APPROVAL_DELIVERY_FAILED");
    } finally {
      await env.close();
    }
  });
});
