import { createHash } from "node:crypto";
import { z } from "zod";
import { DecisionRuleSchema } from "./rules.js";
import {
  DECISION_POLICY_STATES,
  type DecisionPolicyState,
} from "./policy-state.js";
import { canonicalizePredicate } from "./predicates.js";

export const INITIAL_DECISION_POLICY_VERSION = 1;

export const DecisionPolicyCandidateSchema = z
  .object({
    decisionPolicyId: z.string().min(1),
    decisionPolicyVersion: z.number().int().positive(),
    decisionContextId: z.string().min(1),
    decisionContextVersion: z.number().int().positive(),
    decisionContextHash: z.string().min(1),
    rules: z.array(DecisionRuleSchema).default([]),
    defaultActionId: z.string().min(1),
    sourceEvidenceRefs: z.array(z.string().min(1)).default([]),
    sourcePromotedCausalClaimIds: z.array(z.string().min(1)).default([]),
    sourceScenarioRefs: z.array(z.string().min(1)).default([]),
    sourceScenarioHashes: z.array(z.string().min(1)).default([]),
    sourceCausalBindings: z
      .array(
        z
          .object({
            promotedCausalClaimId: z.string().min(1),
            promotedClaimHash: z.string().min(1),
            sourceClaimHash: z.string().min(1),
            reviewRecordId: z.string().min(1),
            scopeAssessment: z.enum([
              "DIRECTLY_SUPPORTED",
              "PARTIALLY_SUPPORTED",
              "EXTRAPOLATED",
              "NOT_SUPPORTED",
            ]),
            generalizability: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    objectiveWeights: z
      .record(z.string().min(1), z.number().finite().nonnegative())
      .default({}),
    riskConstraints: z
      .object({
        maxRiskClass: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("HIGH"),
        maxUnsupportedStateRate: z.number().min(0).max(1).default(0.5),
        maxConstraintViolations: z.number().int().nonnegative().default(0),
        maxObservedLoss: z.number().finite().optional(),
        maxStaleSourceRate: z.number().min(0).max(1).default(0.1),
      })
      .strict()
      .default({}),
    evaluationRequirements: z
      .object({
        requireOfflineEvaluation: z.boolean().default(true),
        requireShadowEvidence: z.boolean().default(true),
        minimumShadowRecords: z.number().int().nonnegative().default(1),
        minimumCoverage: z.number().min(0).max(1).default(0),
        minimumEvidenceQuality: z
          .enum(["VALIDATED", "PARTIAL", "DEGRADED", "UNKNOWN"])
          .default("PARTIAL"),
      })
      .strict()
      .default({}),
    synthesisModelId: z.string().min(1).optional(),
    synthesisModelVersion: z.string().min(1).optional(),
    policyHash: z.string().min(1),
    status: z.enum(DECISION_POLICY_STATES),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    createdBy: z.string().min(1),
    recordRevision: z.number().int().min(1),
    governancePolicyFingerprint: z.string().min(1).optional(),
    capabilitySetFingerprint: z.string().min(1).optional(),
  })
  .strict();

export type DecisionPolicyCandidate = z.infer<
  typeof DecisionPolicyCandidateSchema
>;

export function computeDecisionPolicyHash(input: {
  decisionPolicyId: string;
  decisionPolicyVersion: number;
  decisionContextId: string;
  decisionContextVersion: number;
  decisionContextHash: string;
  rules: DecisionPolicyCandidate["rules"];
  defaultActionId: string;
  objectiveWeights: Record<string, number>;
  riskConstraints: DecisionPolicyCandidate["riskConstraints"];
  sourceEvidenceRefs: readonly string[];
  sourcePromotedCausalClaimIds: readonly string[];
  sourceScenarioRefs: readonly string[];
  sourceScenarioHashes?: readonly string[];
  sourceCausalBindings?: DecisionPolicyCandidate["sourceCausalBindings"];
  evaluationRequirements: DecisionPolicyCandidate["evaluationRequirements"];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        decisionPolicyId: input.decisionPolicyId,
        decisionPolicyVersion: input.decisionPolicyVersion,
        decisionContextId: input.decisionContextId,
        decisionContextVersion: input.decisionContextVersion,
        decisionContextHash: input.decisionContextHash,
        rules: input.rules.map((r) => ({
          decisionRuleId: r.decisionRuleId,
          name: r.name,
          predicate: canonicalizePredicate(r.predicate),
          actionId: r.actionId,
          priority: r.priority,
          evidenceRefs: [...r.evidenceRefs].sort(),
          promotedCausalClaimIds: [...r.promotedCausalClaimIds].sort(),
          confidence: r.confidence,
          heuristicOnly: r.heuristicOnly,
          limitations: r.limitations,
        })),
        defaultActionId: input.defaultActionId,
        objectiveWeights: Object.fromEntries(
          Object.entries(input.objectiveWeights).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        ),
        riskConstraints: input.riskConstraints,
        sourceEvidenceRefs: [...input.sourceEvidenceRefs].sort(),
        sourcePromotedCausalClaimIds: [
          ...input.sourcePromotedCausalClaimIds,
        ].sort(),
        sourceScenarioRefs: [...input.sourceScenarioRefs].sort(),
        sourceScenarioHashes: [...(input.sourceScenarioHashes ?? [])].sort(),
        sourceCausalBindings: [...(input.sourceCausalBindings ?? [])].sort(
          (a, b) =>
            a.promotedCausalClaimId.localeCompare(b.promotedCausalClaimId),
        ),
        evaluationRequirements: input.evaluationRequirements,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withDecisionPolicyHash(
  input: Omit<DecisionPolicyCandidate, "policyHash">,
): DecisionPolicyCandidate {
  const policyHash = computeDecisionPolicyHash({
    decisionPolicyId: input.decisionPolicyId,
    decisionPolicyVersion: input.decisionPolicyVersion,
    decisionContextId: input.decisionContextId,
    decisionContextVersion: input.decisionContextVersion,
    decisionContextHash: input.decisionContextHash,
    rules: input.rules,
    defaultActionId: input.defaultActionId,
    objectiveWeights: input.objectiveWeights,
    riskConstraints: input.riskConstraints,
    sourceEvidenceRefs: input.sourceEvidenceRefs,
    sourcePromotedCausalClaimIds: input.sourcePromotedCausalClaimIds,
    sourceScenarioRefs: input.sourceScenarioRefs,
    sourceScenarioHashes: input.sourceScenarioHashes,
    sourceCausalBindings: input.sourceCausalBindings,
    evaluationRequirements: input.evaluationRequirements,
  });
  return DecisionPolicyCandidateSchema.parse({ ...input, policyHash });
}

export function mintDecisionPolicyId(input: {
  decisionContextId: string;
  createdAt: string;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        decisionContextId: input.decisionContextId,
        createdAt: input.createdAt,
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 16);
  return `dpol_${digest}`;
}

export function parseDecisionPolicyCandidate(
  raw: unknown,
): DecisionPolicyCandidate {
  return DecisionPolicyCandidateSchema.parse(raw);
}

export type { DecisionPolicyState };
