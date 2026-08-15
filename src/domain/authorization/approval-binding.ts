import { z } from "zod";
import { ObjectiveVersionSchema } from "../objective/objective.js";
import { PlanVersionSchema } from "../plan/execution-plan.js";

/**
 * Immutable binding between a human decision and the exact authority context
 * shown to the approver. Any change to a bound field invalidates the approval.
 */
export const ApprovalBindingSchema = z
  .object({
    projectId: z.string().min(1),
    objectiveId: z.string().min(1),
    objectiveVersion: ObjectiveVersionSchema,
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    repositoryCommitSha: z.string().min(1),
    repositoryFingerprint: z.string().min(1),
    policyBundleHash: z.string().min(1),
    validationDecisionId: z.string().min(1),
    approvalRequestId: z.string().min(1),
    approverId: z.string().min(1),
    decision: z.enum(["APPROVE", "REJECT", "REQUEST_MODIFICATION"]),
    decisionTimestamp: z.string().datetime(),
    expiryTimestamp: z.string().datetime(),
    decisionCardHash: z.string().min(1),
    capabilitySetFingerprint: z.string().min(1),
  })
  .strict();

export type ApprovalBinding = z.infer<typeof ApprovalBindingSchema>;

export function parseApprovalBinding(input: unknown): ApprovalBinding {
  return ApprovalBindingSchema.parse(input);
}

/** Binding key used to detect duplicate pending requests for the same plan. */
export function approvalBindingKey(input: {
  runId: string;
  planId: string;
  planVersion: number;
  planHash: string;
  validationDecisionId: string;
  decisionCardHash: string;
}): string {
  return [
    input.runId,
    input.planId,
    String(input.planVersion),
    input.planHash,
    input.validationDecisionId,
    input.decisionCardHash,
  ].join(":");
}
