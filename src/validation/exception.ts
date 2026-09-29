import { z } from "zod";
import { PlanVersionSchema } from "../domain/plan/execution-plan.js";
import {
  ValidationFindingSchema,
  type ValidationDecision,
  type ValidationDecisionClass,
  type ValidationFinding,
} from "../domain/validation/index.js";
import {
  isRevisionFailureCauseClass,
  safeCode,
} from "./revision-failure-cause.js";

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

/** Rule ids ValidationService uses for the synthetic revision-failure finding. */
const REVISION_FAILURE_RULE_IDS: readonly PlanningExceptionType[] = [
  "REVISION_FAILED",
  "REVISION_BUDGET_EXCEEDED",
];

/**
 * Display-safe exception summary for the DecisionCard: codes and a
 * deterministic message only — never prompts, stack traces, or provider text.
 */
export interface PlanningExceptionSummary {
  exceptionId: string;
  exceptionType: PlanningExceptionType;
  message: string;
  reasonCodes: string[];
  causeClass?: string;
  causeCode?: string;
}

function revisionFailureFinding(
  findings: readonly ValidationFinding[],
): ValidationFinding | undefined {
  return findings.find(
    (finding) =>
      finding.validatorType === "STATE" &&
      finding.category === "revision" &&
      REVISION_FAILURE_RULE_IDS.includes(
        finding.ruleId as PlanningExceptionType,
      ),
  );
}

function safeCause(
  finding: ValidationFinding | undefined,
): Pick<PlanningExceptionSummary, "causeClass" | "causeCode"> {
  if (!finding) {
    return {};
  }
  const declaredClass = finding.metadata["causeClass"];
  const causeClass = isRevisionFailureCauseClass(declaredClass)
    ? declaredClass
    : undefined;
  const causeCode = safeCode(finding.metadata["causeCode"]);
  return {
    ...(causeClass !== undefined ? { causeClass } : {}),
    ...(causeCode !== undefined ? { causeCode } : {}),
  };
}

function uniqueCodes(codes: readonly (string | undefined)[]): string[] {
  return [
    ...new Set(
      codes.filter((code): code is string => code !== undefined && code !== ""),
    ),
  ];
}

export function summarizePlanningException(
  exception: PlanningException,
): PlanningExceptionSummary {
  const failure = revisionFailureFinding(exception.findings);
  return {
    exceptionId: exception.exceptionId,
    exceptionType: exception.exceptionType,
    message: `Automated validation stopped: ${exception.exceptionType}`,
    reasonCodes: uniqueCodes(
      exception.reasonCodes.map((code) => safeCode(code)),
    ),
    ...safeCause(failure),
  };
}

/**
 * Reconstructs the planning exception summary from the persisted, authoritative
 * ValidationDecision. PlanningException itself is not persisted; the
 * revision-failure finding and its sanitized metadata are.
 */
export function planningExceptionSummaryFromDecision(
  decision: ValidationDecision,
): PlanningExceptionSummary | undefined {
  const failure = revisionFailureFinding(decision.findings);
  if (!failure) {
    return undefined;
  }
  const exceptionType = failure.ruleId as PlanningExceptionType;
  return {
    exceptionId: `pex_${decision.validationDecisionId}`,
    exceptionType,
    message: `Automated validation stopped: ${exceptionType}`,
    reasonCodes: uniqueCodes([
      exceptionType,
      safeCode(failure.metadata["code"]),
    ]),
    ...safeCause(failure),
  };
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
