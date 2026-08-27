import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * EXPERIMENT_SPONSOR ≠ APPROVER ≠ STRATEGY_SELECTOR ≠ PORTFOLIO_ALLOCATOR
 * ≠ PROGRAM_MATERIALIZER.
 *
 * ExperimentAuthorizationRecord ≠ Phase 6 AuthorizationRecord.
 */
export const EXPERIMENT_SPONSOR_AUTHORITY_BOUNDARIES = {
  experimentSponsor:
    "EXPERIMENT_SPONSOR approves experiment design — does not authorize execution",
  approver: "Phase 6 APPROVER authorizes operational execution — not experiment design",
  strategySelector:
    "STRATEGY_SELECTOR chooses scenarios — not experiment sponsorship",
  portfolioAllocator:
    "PORTFOLIO_ALLOCATOR authorizes capital — not experiment sponsorship",
  programMaterializer:
    "PROGRAM_MATERIALIZER approves decomposition — not experiment sponsorship",
} as const;

export const ExperimentAuthorizationDecisionSchema = z.enum([
  "APPROVE_EXPERIMENT",
  "REJECT_EXPERIMENT",
  "REQUEST_REVISION",
]);
export type ExperimentAuthorizationDecision = z.infer<
  typeof ExperimentAuthorizationDecisionSchema
>;

export const ExperimentAuthorizationRequestSchema = z
  .object({
    authorizationId: z.string().min(1),
    experimentId: z.string().min(1),
    experimentVersion: z.number().int().positive(),
    experimentPlanVersion: z.number().int().positive(),
    experimentPlanHash: z.string().min(1),
    policyBundleFingerprint: z.string().min(1),
    capabilitySetFingerprint: z.string().min(1),
    projectConfigurationFingerprint: z.string().min(1),
    budgetFingerprint: z.string().min(1),
    riskClass: z.enum(["LOW", "MEDIUM", "HIGH"]),
    subjectHash: z.string().min(1),
    decisionNonceHash: z.string().min(1),
    status: z.enum(["PENDING", "DECIDED", "EXPIRED"]),
    sponsorId: z.string().min(1).optional(),
    decision: ExperimentAuthorizationDecisionSchema.optional(),
    decidedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type ExperimentAuthorizationRequest = z.infer<
  typeof ExperimentAuthorizationRequestSchema
>;

export const ExperimentAuthorizationRecordSchema = z
  .object({
    authorizationRecordId: z.string().min(1),
    authorizationId: z.string().min(1),
    experimentId: z.string().min(1),
    experimentVersion: z.number().int().positive(),
    experimentPlanVersion: z.number().int().positive(),
    experimentPlanHash: z.string().min(1),
    sponsorId: z.string().min(1),
    decision: ExperimentAuthorizationDecisionSchema,
    subjectHash: z.string().min(1),
    decisionNonceHash: z.string().min(1),
    decidedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type ExperimentAuthorizationRecord = z.infer<
  typeof ExperimentAuthorizationRecordSchema
>;

export function computeExperimentAuthSubjectHash(input: {
  experimentId: string;
  experimentVersion: number;
  experimentPlanVersion: number;
  experimentPlanHash: string;
  policyBundleFingerprint: string;
  capabilitySetFingerprint: string;
  projectConfigurationFingerprint: string;
  budgetFingerprint: string;
  riskClass: string;
  expiresAt: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function mintExperimentAuthorizationId(input: {
  experimentId: string;
  experimentPlanHash: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `eaux_${input.experimentId}_${digest}`.slice(0, 120);
}

export function mintExperimentAuthorizationRecordId(input: {
  authorizationId: string;
  decidedAt: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `eauxrec_${digest}`;
}

export function budgetFingerprint(envelope: {
  maximumActions: number;
  maximumDurationHours: number;
  maximumModelCalls: number;
  maximumTotalTokens: number;
  maximumSampleSize: number;
  maximumEstimatedCost: number;
  maximumExternalSideEffects: number;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(envelope), "utf8")
    .digest("hex");
}

export function assertExperimentAuthorizationDoesNotExecute(): void {
  // Documentation hook: sponsor approval ≠ Phase 6 execution.
}

export function assertExperimentSponsorDistinctFromApprover(): void {
  // Documentation hook.
}

export function assertExperimentSponsorDistinctFromStrategySelector(): void {
  // Documentation hook.
}
