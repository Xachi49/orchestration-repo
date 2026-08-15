import { z } from "zod";
import { PlanVersionSchema } from "../domain/plan/execution-plan.js";
import {
  ValidationFindingSchema,
  type ValidationDecisionClass,
  type ValidationFinding,
} from "../domain/validation/index.js";

export const PlanningExceptionTypeSchema = z.enum([
  "UNREPAIRABLE_VIOLATION",
  "REPEATED_SEMANTIC_VIOLATION",
  "REVISION_ATTEMPTS_EXHAUSTED",
  "REVISION_FAILED",
  "REVISION_BUDGET_EXCEEDED",
  "AUTHORITY_UNAVAILABLE",
]);
export type PlanningExceptionType = z.infer<typeof PlanningExceptionTypeSchema>;

/**
 * A planning exception is a hand-off, not a resolution.
 *
 * It records that automated adjudication has stopped and why, and it never
 * carries approval authority: `requiresHumanDecision` is always true and the
 * run stays where the decision left it.
 */
export const PlanningExceptionSchema = z
  .object({
    exceptionId: z.string().min(1),
    runId: z.string().min(1),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    exceptionType: PlanningExceptionTypeSchema,
    decisionClass: z.enum(["BLOCK", "HUMAN_APPROVAL_REQUIRED"]),
    reasonCodes: z.array(z.string().min(1)).min(1),
    message: z.string().min(1),
    findings: z.array(ValidationFindingSchema),
    validationAttempt: z.number().int().positive(),
    revisionAttemptsUsed: z.number().int().nonnegative(),
    raisedAt: z.string().datetime(),
    requiresHumanDecision: z.literal(true),
  })
  .strict();
export type PlanningException = z.infer<typeof PlanningExceptionSchema>;

export function parsePlanningException(input: unknown): PlanningException {
  return PlanningExceptionSchema.parse(input);
}

export function createPlanningException(input: {
  exceptionId: string;
  runId: string;
  planId: string;
  planVersion: number;
  planHash: string;
  exceptionType: PlanningExceptionType;
  decisionClass: Extract<
    ValidationDecisionClass,
    "BLOCK" | "HUMAN_APPROVAL_REQUIRED"
  >;
  reasonCodes: readonly string[];
  message: string;
  findings: readonly ValidationFinding[];
  validationAttempt: number;
  revisionAttemptsUsed: number;
  raisedAt: string;
}): PlanningException {
  return parsePlanningException({
    exceptionId: input.exceptionId,
    runId: input.runId,
    planId: input.planId,
    planVersion: input.planVersion,
    planHash: input.planHash,
    exceptionType: input.exceptionType,
    decisionClass: input.decisionClass,
    reasonCodes: [...input.reasonCodes],
    message: input.message,
    findings: [...input.findings],
    validationAttempt: input.validationAttempt,
    revisionAttemptsUsed: input.revisionAttemptsUsed,
    raisedAt: input.raisedAt,
    requiresHumanDecision: true,
  });
}
