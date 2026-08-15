import { z } from "zod";
import { OutcomeVerdictSchema } from "../domain/verification/outcome.js";
import { VerificationFindingSchema } from "../domain/verification/finding.js";
import {
  AcceptanceCriterionResultSchema,
  StepPostconditionResultSchema,
} from "../domain/verification/criterion-result.js";
import { PostExecutionSnapshotSchema } from "../domain/verification/snapshot.js";
import { VerificationEvidenceSchema } from "../domain/verification/evidence.js";
import { PlanVersionSchema } from "../domain/plan/execution-plan.js";

/**
 * Bounded contextual input for VerificationModel.
 * Evidence remains DATA. No planner/validator/executor chain-of-thought.
 */
export const ContextualOutcomeInputSchema = z
  .object({
    runId: z.string().min(1),
    objectiveId: z.string().min(1),
    objectiveVersion: z.number().int().positive(),
    requestedOutcome: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    constraints: z.array(z.string()),
    nonGoals: z.array(z.string()),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    postExecutionSnapshot: PostExecutionSnapshotSchema,
    evidence: z.array(VerificationEvidenceSchema),
    criterionResults: z.array(AcceptanceCriterionResultSchema),
    postconditionResults: z.array(StepPostconditionResultSchema),
    findings: z.array(VerificationFindingSchema),
    expectedPostconditions: z.array(z.string()),
  })
  .strict();

export type ContextualOutcomeInput = z.infer<
  typeof ContextualOutcomeInputSchema
>;

export function parseContextualOutcomeInput(
  input: unknown,
): ContextualOutcomeInput {
  return ContextualOutcomeInputSchema.parse(input);
}

export const ContextualOutcomeAssessmentSchema = z
  .object({
    recommendedOutcome: OutcomeVerdictSchema.exclude(["CONTAINED"]),
    criterionConcerns: z.array(z.string()),
    unsupportedClaims: z.array(z.string()),
    contradictions: z.array(z.string()),
    missingEvidence: z.array(z.string()),
    semanticGaps: z.array(z.string()),
    conciseRationale: z.string().min(1),
    findings: z.array(VerificationFindingSchema),
  })
  .strict();

export type ContextualOutcomeAssessment = z.infer<
  typeof ContextualOutcomeAssessmentSchema
>;

export function parseContextualOutcomeAssessment(
  input: unknown,
): ContextualOutcomeAssessment {
  return ContextualOutcomeAssessmentSchema.parse(input);
}

export interface VerificationModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface VerificationModelOutput<T> {
  value: T;
  usage?: VerificationModelTokenUsage;
}

/**
 * Provider-independent verification model port.
 * Separate from PlanningModel and ValidationModel.
 * May downgrade success; cannot create VERIFIED_SUCCESS authority.
 * Must not create evidence, call tools, execute, replan, or approve.
 */
export interface VerificationModel {
  readonly provider: string;
  readonly modelId: string;
  readonly toolsEnabled: false;
  assessOutcome(
    input: ContextualOutcomeInput,
  ): Promise<VerificationModelOutput<ContextualOutcomeAssessment>>;
}
