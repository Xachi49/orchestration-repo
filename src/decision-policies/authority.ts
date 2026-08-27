import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * DECISION_POLICY_APPROVER ≠ APPROVER ≠ CAUSAL_REVIEWER ≠ EXPERIMENT_SPONSOR
 * ≠ STRATEGY_SELECTOR ≠ PORTFOLIO_ALLOCATOR ≠ PROGRAM_MATERIALIZER.
 *
 * Initial approval grants SHADOW eligibility only — not live activation.
 */
export const DECISION_POLICY_APPROVER_AUTHORITY_BOUNDARIES = {
  decisionPolicyApprover:
    "DECISION_POLICY_APPROVER may approve SHADOW eligibility — not live activation or execution",
  decisionPolicyActivator:
    "DECISION_POLICY_ACTIVATOR may activate recommendation authority — not execution",
  approver: "Phase 6 APPROVER authorizes operational execution — not decision policies",
  causalReviewer: "CAUSAL_REVIEWER promotes causal knowledge — not decision policies",
  experimentSponsor: "EXPERIMENT_SPONSOR sponsors experiments — not decision policies",
  strategySelector: "STRATEGY_SELECTOR chooses scenarios — not decision policies",
  portfolioAllocator: "PORTFOLIO_ALLOCATOR authorizes capital — not decision policies",
  programMaterializer:
    "PROGRAM_MATERIALIZER approves decomposition — not decision policies",
  shadowNotLive: "SHADOW_MODE != LIVE_AUTHORITY",
  policyApprovalNotAction: "POLICY_APPROVAL != ACTION_APPROVAL",
} as const;

export const DecisionPolicyApprovalDecisionSchema = z.enum([
  "APPROVE_SHADOW",
  "REJECT",
  "REQUEST_REVISION",
]);
export type DecisionPolicyApprovalDecision = z.infer<
  typeof DecisionPolicyApprovalDecisionSchema
>;

export const DecisionPolicyApprovalRequestSchema = z
  .object({
    decisionPolicyApprovalRequestId: z.string().min(1),
    decisionPolicyId: z.string().min(1),
    decisionPolicyVersion: z.number().int().positive(),
    policyHash: z.string().min(1),
    decisionContextId: z.string().min(1),
    decisionContextVersion: z.number().int().positive(),
    decisionContextHash: z.string().min(1),
    evaluationId: z.string().min(1),
    evaluationHash: z.string().min(1),
    comparisonId: z.string().min(1).optional(),
    comparisonHash: z.string().min(1).optional(),
    evidenceFingerprints: z.array(z.string().min(1)).default([]),
    governancePolicyFingerprint: z.string().min(1),
    capabilitySetFingerprint: z.string().min(1),
    projectIds: z.array(z.string().min(1)).min(1),
    environmentScope: z.array(z.string().min(1)).min(1),
    subjectHash: z.string().min(1),
    decisionNonceHash: z.string().min(1),
    status: z.enum(["PENDING", "DECIDED", "EXPIRED"]),
    approverId: z.string().min(1).optional(),
    decision: DecisionPolicyApprovalDecisionSchema.optional(),
    decidedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type DecisionPolicyApprovalRequest = z.infer<
  typeof DecisionPolicyApprovalRequestSchema
>;

export const DecisionPolicyApprovalRecordSchema = z
  .object({
    decisionPolicyApprovalRecordId: z.string().min(1),
    decisionPolicyApprovalRequestId: z.string().min(1),
    decisionPolicyId: z.string().min(1),
    decisionPolicyVersion: z.number().int().positive(),
    policyHash: z.string().min(1),
    approverId: z.string().min(1),
    decision: DecisionPolicyApprovalDecisionSchema,
    subjectHash: z.string().min(1),
    decisionNonceHash: z.string().min(1),
    decidedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type DecisionPolicyApprovalRecord = z.infer<
  typeof DecisionPolicyApprovalRecordSchema
>;

export function computeDecisionPolicyApprovalSubjectHash(input: {
  decisionPolicyId: string;
  decisionPolicyVersion: number;
  policyHash: string;
  decisionContextId: string;
  decisionContextVersion: number;
  decisionContextHash: string;
  evaluationId: string;
  evaluationHash: string;
  comparisonId?: string;
  comparisonHash?: string;
  governancePolicyFingerprint: string;
  capabilitySetFingerprint: string;
  projectIds: readonly string[];
  environmentScope: readonly string[];
  expiresAt: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...input,
        projectIds: [...input.projectIds].sort(),
        environmentScope: [...input.environmentScope].sort(),
      }),
      "utf8",
    )
    .digest("hex");
}

export function mintDecisionPolicyApprovalRequestId(input: {
  decisionPolicyId: string;
  policyHash: string;
}): string {
  return `dpar_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}

export function mintDecisionPolicyApprovalRecordId(input: {
  decisionPolicyApprovalRequestId: string;
  decidedAt: string;
}): string {
  return `dparec_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}

export const DecisionPolicyActivationDecisionSchema = z.enum([
  "ACTIVATE",
  "REJECT",
  "REQUEST_MORE_SHADOW_EVIDENCE",
]);
export type DecisionPolicyActivationDecision = z.infer<
  typeof DecisionPolicyActivationDecisionSchema
>;

export const DecisionPolicyActivationRequestSchema = z
  .object({
    decisionPolicyActivationRequestId: z.string().min(1),
    decisionPolicyId: z.string().min(1),
    decisionPolicyVersion: z.number().int().positive(),
    policyHash: z.string().min(1),
    shadowEvaluationId: z.string().min(1),
    shadowEvaluationHash: z.string().min(1),
    approvalRecordId: z.string().min(1),
    approvedScopeProjectIds: z.array(z.string().min(1)).min(1),
    approvedScopeEnvironments: z.array(z.string().min(1)).min(1),
    governancePolicyFingerprint: z.string().min(1),
    capabilitySetFingerprint: z.string().min(1),
    riskLimits: z
      .object({
        maxUnsupportedStateRate: z.number().min(0).max(1),
        maxConstraintViolations: z.number().int().nonnegative(),
        maxStaleSourceRate: z.number().min(0).max(1),
        maxObservedLoss: z.number().finite().optional(),
      })
      .strict(),
    activationWindow: z
      .object({
        validFrom: z.string().datetime(),
        validUntil: z.string().datetime(),
      })
      .strict(),
    subjectHash: z.string().min(1),
    decisionNonceHash: z.string().min(1),
    status: z.enum(["PENDING", "DECIDED", "EXPIRED"]),
    activatorId: z.string().min(1).optional(),
    decision: DecisionPolicyActivationDecisionSchema.optional(),
    decidedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type DecisionPolicyActivationRequest = z.infer<
  typeof DecisionPolicyActivationRequestSchema
>;

export const DecisionPolicyActivationRecordSchema = z
  .object({
    decisionPolicyActivationId: z.string().min(1),
    decisionPolicyActivationVersion: z.number().int().positive().default(1),
    decisionPolicyActivationRequestId: z.string().min(1),
    decisionPolicyId: z.string().min(1),
    decisionPolicyVersion: z.number().int().positive(),
    policyHash: z.string().min(1),
    shadowEvaluationHash: z.string().min(1),
    activationScopeProjectIds: z.array(z.string().min(1)).min(1),
    activationScopeEnvironments: z.array(z.string().min(1)).min(1),
    activationAuthorityPrincipalId: z.string().min(1),
    validFrom: z.string().datetime(),
    validUntil: z.string().datetime(),
    runtimeConstraints: z
      .object({
        maxUnsupportedStateRate: z.number().min(0).max(1),
        maxConstraintViolations: z.number().int().nonnegative(),
        maxStaleSourceRate: z.number().min(0).max(1),
        maxObservedLoss: z.number().finite().optional(),
      })
      .strict(),
    governancePolicyFingerprint: z.string().min(1),
    capabilitySetFingerprint: z.string().min(1),
    activationHash: z.string().min(1),
    status: z.enum(["ACTIVE", "PAUSED", "EXPIRED", "REVOKED"]),
    createdAt: z.string().datetime(),
  })
  .strict();

export type DecisionPolicyActivationRecord = z.infer<
  typeof DecisionPolicyActivationRecordSchema
>;

export function computeActivationSubjectHash(input: {
  decisionPolicyId: string;
  decisionPolicyVersion: number;
  policyHash: string;
  shadowEvaluationId: string;
  shadowEvaluationHash: string;
  approvalRecordId: string;
  governancePolicyFingerprint: string;
  capabilitySetFingerprint: string;
  expiresAt: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function computeActivationHash(input: {
  decisionPolicyId: string;
  decisionPolicyVersion: number;
  policyHash: string;
  shadowEvaluationHash: string;
  activationAuthorityPrincipalId: string;
  validFrom: string;
  validUntil: string;
  governancePolicyFingerprint: string;
  capabilitySetFingerprint: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function mintActivationRequestId(input: {
  decisionPolicyId: string;
  policyHash: string;
  shadowEvaluationHash: string;
}): string {
  return `dpactreq_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}

export function mintActivationRecordId(input: {
  decisionPolicyActivationRequestId: string;
  decidedAt: string;
}): string {
  return `dpact_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}
