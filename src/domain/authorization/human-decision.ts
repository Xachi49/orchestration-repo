import { z } from "zod";

export const HumanDecisionKindSchema = z.enum([
  "APPROVE",
  "REJECT",
  "REQUEST_MODIFICATION",
]);
export type HumanDecisionKind = z.infer<typeof HumanDecisionKindSchema>;

/**
 * Human authorization input. The system resolves all plan/hash/policy binding
 * from the stored ApprovalRequest — callers must not supply plan authority.
 */
export const HumanAuthorizationDecisionSchema = z
  .object({
    approvalRequestId: z.string().min(1),
    approverId: z.string().min(1),
    decision: HumanDecisionKindSchema,
    submittedAt: z.string().datetime(),
    decisionNonce: z.string().min(1),
    note: z.string().max(4000).optional(),
    /** Required only when an active institutional mandate applies (Phase 20). */
    institutionalProofId: z.string().min(1).optional(),
  })
  .strict();

export type HumanAuthorizationDecision = z.infer<
  typeof HumanAuthorizationDecisionSchema
>;

export function parseHumanAuthorizationDecision(
  input: unknown,
): HumanAuthorizationDecision {
  return HumanAuthorizationDecisionSchema.parse(input);
}
