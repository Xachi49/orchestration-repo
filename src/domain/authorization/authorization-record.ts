import { z } from "zod";
import { ObjectiveVersionSchema } from "../objective/objective.js";
import { PlanVersionSchema } from "../plan/execution-plan.js";
import { HumanDecisionKindSchema } from "./human-decision.js";

/**
 * Append-only authorization audit record. Never mutate; correct with a new record.
 */
export const AuthorizationRecordSchema = z
  .object({
    authorizationRecordId: z.string().min(1),
    approvalRequestId: z.string().min(1),
    runId: z.string().min(1),
    projectId: z.string().min(1),
    objectiveId: z.string().min(1),
    objectiveVersion: ObjectiveVersionSchema,
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    repositoryFingerprint: z.string().min(1),
    policyBundleHash: z.string().min(1),
    validationDecisionId: z.string().min(1),
    approverId: z.string().min(1),
    decision: HumanDecisionKindSchema,
    decisionTimestamp: z.string().datetime(),
    decisionCardHash: z.string().min(1),
    /**
     * Frozen capability authority from the ApprovalRequest / decision card.
     * Exact match required at execution readiness and preflight.
     */
    capabilitySetFingerprint: z.string().min(1),
    nonceHash: z.string().min(1),
    createdAt: z.string().datetime(),
    note: z.string().max(4000).optional(),
  })
  .strict();

export type AuthorizationRecord = z.infer<typeof AuthorizationRecordSchema>;

export function parseAuthorizationRecord(input: unknown): AuthorizationRecord {
  return AuthorizationRecordSchema.parse(input);
}
