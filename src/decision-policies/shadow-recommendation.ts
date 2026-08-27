import { createHash } from "node:crypto";
import { z } from "zod";
import { CounterfactualSupportStatusSchema } from "./evaluation.js";
import { ExecutionPathSchema } from "./variables-actions.js";

export const ShadowDecisionRecordSchema = z
  .object({
    shadowDecisionRecordId: z.string().min(1),
    decisionPolicyId: z.string().min(1),
    decisionPolicyVersion: z.number().int().positive(),
    policyHash: z.string().min(1),
    contextSnapshotHash: z.string().min(1),
    matchedRuleId: z.string().min(1).nullable(),
    recommendedActionId: z.string().min(1),
    actualActionId: z.string().min(1).optional(),
    actualVerifiedOutcomeRefs: z.array(z.string().min(1)).default([]),
    counterfactualSupportStatus: CounterfactualSupportStatusSchema,
    timestamp: z.string().datetime(),
    limitations: z.array(z.string().min(1)).default([
      "SHADOW_MODE != LIVE_AUTHORITY",
      "Shadow creates zero Objectives / Programs / Portfolio proposals / Experiments / execution attempts",
    ]),
  })
  .strict();

export type ShadowDecisionRecord = z.infer<typeof ShadowDecisionRecordSchema>;

export const DecisionPolicyShadowEvaluationSchema = z
  .object({
    decisionPolicyShadowEvaluationId: z.string().min(1),
    decisionPolicyId: z.string().min(1),
    decisionPolicyVersion: z.number().int().positive(),
    policyHash: z.string().min(1),
    coverage: z.number().min(0).max(1),
    ruleHitDistribution: z.record(z.string(), z.number().int().nonnegative()),
    constraintFailures: z.number().int().nonnegative(),
    recommendationDisagreementRate: z.number().min(0).max(1),
    verifiedOutcomeAlignmentRate: z.number().min(0).max(1).optional(),
    unsupportedStateRate: z.number().min(0).max(1),
    resourceEstimate: z
      .object({
        tokens: z.number().nonnegative().optional(),
        usd: z.number().nonnegative().optional(),
      })
      .strict()
      .default({}),
    evidenceQuality: z.enum(["VALIDATED", "PARTIAL", "DEGRADED", "UNKNOWN"]),
    shadowRecordCount: z.number().int().nonnegative(),
    limitations: z.array(z.string().min(1)).default([
      "Shadow performance != deployment authority",
    ]),
    shadowEvaluationHash: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export type DecisionPolicyShadowEvaluation = z.infer<
  typeof DecisionPolicyShadowEvaluationSchema
>;

export function mintShadowRecordId(input: {
  policyHash: string;
  contextSnapshotHash: string;
}): string {
  return `sdp_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 20)}`;
}

export function aggregateShadowEvaluation(input: {
  decisionPolicyId: string;
  decisionPolicyVersion: number;
  policyHash: string;
  records: readonly ShadowDecisionRecord[];
  nowIso: string;
}): DecisionPolicyShadowEvaluation {
  const ruleHitDistribution: Record<string, number> = {};
  let unsupported = 0;
  let disagreements = 0;
  let comparable = 0;
  for (const r of input.records) {
    const key = r.matchedRuleId ?? "DEFAULT";
    ruleHitDistribution[key] = (ruleHitDistribution[key] ?? 0) + 1;
    if (r.matchedRuleId === null && r.recommendedActionId.includes("no_action")) {
      // default path — not unsupported by itself
    }
    if (r.limitations.some((l) => l.includes("unsupported"))) {
      unsupported += 1;
    }
    if (r.actualActionId !== undefined) {
      comparable += 1;
      if (r.actualActionId !== r.recommendedActionId) disagreements += 1;
    }
  }
  const n = input.records.length;
  const base = {
    decisionPolicyShadowEvaluationId: `dpsev_${createHash("sha256")
      .update(`${input.policyHash}:${input.nowIso}`, "utf8")
      .digest("hex")
      .slice(0, 16)}`,
    decisionPolicyId: input.decisionPolicyId,
    decisionPolicyVersion: input.decisionPolicyVersion,
    policyHash: input.policyHash,
    coverage: n === 0 ? 0 : 1 - unsupported / n,
    ruleHitDistribution,
    constraintFailures: 0,
    recommendationDisagreementRate:
      comparable === 0 ? 0 : disagreements / comparable,
    unsupportedStateRate: n === 0 ? 1 : unsupported / n,
    resourceEstimate: {},
    evidenceQuality: "PARTIAL" as const,
    shadowRecordCount: n,
    limitations: [
      "Shadow performance != deployment authority",
      "SHADOW_MODE != LIVE_AUTHORITY",
    ],
    createdAt: input.nowIso,
  };
  return DecisionPolicyShadowEvaluationSchema.parse({
    ...base,
    shadowEvaluationHash: createHash("sha256")
      .update(JSON.stringify(base), "utf8")
      .digest("hex"),
  });
}

export const DecisionRecommendationSchema = z
  .object({
    decisionRecommendationId: z.string().min(1),
    decisionPolicyId: z.string().min(1),
    decisionPolicyVersion: z.number().int().positive(),
    policyHash: z.string().min(1),
    activationRecordId: z.string().min(1),
    activationHash: z.string().min(1),
    stateSnapshotId: z.string().min(1),
    stateSnapshotHash: z.string().min(1),
    matchedRuleId: z.string().min(1).nullable(),
    recommendedActionId: z.string().min(1),
    executionPath: ExecutionPathSchema,
    evidenceRefs: z.array(z.string().min(1)).default([]),
    expectedOutcome: z.string().min(1).optional(),
    uncertainty: z.enum(["LOW", "MEDIUM", "HIGH", "UNSUPPORTED"]).default("MEDIUM"),
    riskClass: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    requiredDownstreamAuthority: z.array(z.string().min(1)).default([]),
    recommendationHash: z.string().min(1),
    createdAt: z.string().datetime(),
    /** Attribution stages — never claim verified outcome from recommendation alone. */
    attribution: z
      .object({
        recommendedByPolicy: z.literal(true),
        materializedFromRecommendation: z.boolean().default(false),
        authorizedDownstream: z.boolean().default(false),
        executed: z.boolean().default(false),
        verifiedOutcome: z.boolean().default(false),
      })
      .strict()
      .default({
        recommendedByPolicy: true,
        materializedFromRecommendation: false,
        authorizedDownstream: false,
        executed: false,
        verifiedOutcome: false,
      }),
  })
  .strict();

export type DecisionRecommendation = z.infer<
  typeof DecisionRecommendationSchema
>;

export function computeRecommendationIdentity(input: {
  policyId: string;
  policyVersion: number;
  policyHash: string;
  activationHash: string;
  stateSnapshotHash: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function mintDecisionRecommendationId(identityHash: string): string {
  return `drec_${identityHash.slice(0, 24)}`;
}

export const DecisionOverrideRecordSchema = z
  .object({
    decisionOverrideRecordId: z.string().min(1),
    recommendationId: z.string().min(1),
    humanDecision: z.enum(["REJECT", "OVERRIDE_ACTION", "DEFER"]),
    reasonCategory: z.enum([
      "SAFETY",
      "BUSINESS_JUDGMENT",
      "STALE_CONTEXT",
      "OTHER",
    ]),
    overrideActionId: z.string().min(1).optional(),
    principalId: z.string().min(1),
    timestamp: z.string().datetime(),
    notes: z.string().optional(),
  })
  .strict();

export type DecisionOverrideRecord = z.infer<
  typeof DecisionOverrideRecordSchema
>;

export const DecisionPolicyPerformanceRecordSchema = z
  .object({
    decisionPolicyPerformanceRecordId: z.string().min(1),
    decisionPolicyId: z.string().min(1),
    decisionPolicyVersion: z.number().int().positive(),
    recommendationId: z.string().min(1).optional(),
    recommendations: z.number().int().nonnegative().default(0),
    materializations: z.number().int().nonnegative().default(0),
    verifiedDownstreamOutcomes: z.number().int().nonnegative().default(0),
    constraintViolations: z.number().int().nonnegative().default(0),
    resourceUse: z
      .object({
        tokens: z.number().nonnegative().optional(),
        usd: z.number().nonnegative().optional(),
      })
      .strict()
      .default({}),
    observedOutcome: z.number().finite().optional(),
    estimatedVsObservedDelta: z.number().finite().optional(),
    scopeProjectIds: z.array(z.string().min(1)).default([]),
    measurementQuality: z.enum(["VALIDATED", "PARTIAL", "DEGRADED", "UNKNOWN"]),
    attributionStages: z.array(z.string().min(1)).default([]),
    createdAt: z.string().datetime(),
  })
  .strict();

export type DecisionPolicyPerformanceRecord = z.infer<
  typeof DecisionPolicyPerformanceRecordSchema
>;

export const DecisionPolicyRevisionCandidateSchema = z
  .object({
    decisionPolicyRevisionCandidateId: z.string().min(1),
    sourcePolicyId: z.string().min(1),
    sourcePolicyVersion: z.number().int().positive(),
    sourcePolicyHash: z.string().min(1),
    reason: z.string().min(1),
    newEvidenceRefs: z.array(z.string().min(1)).default([]),
    performanceRefs: z.array(z.string().min(1)).default([]),
    proposedRuleChanges: z.array(z.string().min(1)).default([]),
    proposedThresholdChanges: z.array(z.string().min(1)).default([]),
    riskImpact: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    candidateHash: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export type DecisionPolicyRevisionCandidate = z.infer<
  typeof DecisionPolicyRevisionCandidateSchema
>;

export function mintRevisionCandidate(input: {
  sourcePolicyId: string;
  sourcePolicyVersion: number;
  sourcePolicyHash: string;
  reason: string;
  newEvidenceRefs?: readonly string[];
  performanceRefs?: readonly string[];
  proposedRuleChanges?: readonly string[];
  proposedThresholdChanges?: readonly string[];
  riskImpact: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  createdAt: string;
}): DecisionPolicyRevisionCandidate {
  const base = {
    decisionPolicyRevisionCandidateId: "",
    sourcePolicyId: input.sourcePolicyId,
    sourcePolicyVersion: input.sourcePolicyVersion,
    sourcePolicyHash: input.sourcePolicyHash,
    reason: input.reason,
    newEvidenceRefs: [...(input.newEvidenceRefs ?? [])],
    performanceRefs: [...(input.performanceRefs ?? [])],
    proposedRuleChanges: [...(input.proposedRuleChanges ?? [])],
    proposedThresholdChanges: [...(input.proposedThresholdChanges ?? [])],
    riskImpact: input.riskImpact,
    createdAt: input.createdAt,
  };
  const candidateHash = createHash("sha256")
    .update(JSON.stringify(base), "utf8")
    .digest("hex");
  return DecisionPolicyRevisionCandidateSchema.parse({
    ...base,
    decisionPolicyRevisionCandidateId: `dprev_${candidateHash.slice(0, 16)}`,
    candidateHash,
  });
}

export const DecisionPolicyConcentrationAssessmentSchema = z
  .object({
    decisionPolicyId: z.string().min(1),
    decisionPolicyVersion: z.number().int().positive(),
    dominantActionId: z.string().min(1),
    dominantActionRate: z.number().min(0).max(1),
    distinctActionsRecommended: z.number().int().nonnegative(),
    requiresReview: z.boolean(),
    notes: z.string().min(1),
  })
  .strict();

export type DecisionPolicyConcentrationAssessment = z.infer<
  typeof DecisionPolicyConcentrationAssessmentSchema
>;

export function assessPolicyConcentration(input: {
  decisionPolicyId: string;
  decisionPolicyVersion: number;
  actionCounts: Record<string, number>;
  expectedDiversity?: boolean;
}): DecisionPolicyConcentrationAssessment {
  const entries = Object.entries(input.actionCounts);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  const sorted = [...entries].sort((a, b) => b[1]! - a[1]!);
  const [dominantActionId, dominantCount] = sorted[0] ?? ["action_no_action", 0];
  const rate = total === 0 ? 1 : dominantCount! / total;
  const requiresReview = Boolean(input.expectedDiversity) && rate >= 0.9;
  return DecisionPolicyConcentrationAssessmentSchema.parse({
    decisionPolicyId: input.decisionPolicyId,
    decisionPolicyVersion: input.decisionPolicyVersion,
    dominantActionId,
    dominantActionRate: rate,
    distinctActionsRecommended: entries.length,
    requiresReview,
    notes: requiresReview
      ? "High concentration with expected diversity — human review suggested"
      : "Concentration is diagnostic only; not automatically wrong",
  });
}

export const DecisionPolicyEvidenceGapSchema = z
  .object({
    decisionPolicyEvidenceGapId: z.string().min(1),
    decisionPolicyId: z.string().min(1),
    missingAssumption: z.string().min(1),
    mayFeedPhase17ActiveLearning: z.literal(true),
    doesNotAuthorizeExperiment: z.literal(true),
    createdAt: z.string().datetime(),
  })
  .strict();

export type DecisionPolicyEvidenceGap = z.infer<
  typeof DecisionPolicyEvidenceGapSchema
>;
