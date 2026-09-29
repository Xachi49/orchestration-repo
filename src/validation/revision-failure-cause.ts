import { ZodError } from "zod";
import { isPlanningError, type PlanningErrorCode } from "../planning/errors.js";
import { isRecoveryTargetBinderError } from "../revenue-recovery/target-binder.js";
import { isValidationError, type ValidationError } from "./errors.js";

/**
 * Sanitized classification of why an automated revision failed.
 *
 * Persisted on the REVISION_FAILED finding so an incident can distinguish
 * capability denial, target binding, schema, and infrastructure failures
 * without storing stack traces, prompts, provider output, or tenant data.
 */
export const REVISION_FAILURE_CAUSE_CLASSES = [
  "CAPABILITY_REFERENCE",
  "EVIDENCE_REFERENCE",
  "PLAN_DEPENDENCY",
  "PLAN_RESOURCE",
  "PLAN_QUALITY",
  "VERIFICATION_BINDING",
  "RECOVERY_TARGET_GATE",
  "RECOVERY_TARGET_BINDING",
  "PLANNING_VALIDATION",
  "PLAN_SCHEMA",
  "REVISION_MODEL",
  "REVISION_BUDGET",
  "REVISION_PROCESS",
  "INFRASTRUCTURE",
] as const;
export type RevisionFailureCauseClass =
  (typeof REVISION_FAILURE_CAUSE_CLASSES)[number];

export interface RevisionFailureSchemaIssue {
  path: string;
  code: string;
}

export interface RevisionFailureCause {
  causeClass: RevisionFailureCauseClass;
  causeCode: string;
  planningCode?: string;
  binderCode?: string;
  schemaIssues?: RevisionFailureSchemaIssue[];
}

const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SAFE_SCHEMA_PATH = /^[A-Za-z0-9_.*]{0,512}$/;
const MAX_SCHEMA_ISSUES = 5;

/** Detail keys that carry identifiers or codes only — never free text. */
const SAFE_DETAIL_KEYS = [
  "runId",
  "targetPlanVersion",
  "planningCode",
  "binderCode",
  "ruleIds",
  "operation",
] as const;

export function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : undefined;
}

export function isRevisionFailureCauseClass(
  value: unknown,
): value is RevisionFailureCauseClass {
  return isCauseClass(value);
}

function isCauseClass(value: unknown): value is RevisionFailureCauseClass {
  return (
    typeof value === "string" &&
    (REVISION_FAILURE_CAUSE_CLASSES as readonly string[]).includes(value)
  );
}

function planningCauseClass(code: PlanningErrorCode): RevisionFailureCauseClass {
  switch (code) {
    case "INVALID_CAPABILITY_REFERENCE":
      return "CAPABILITY_REFERENCE";
    case "INVALID_EVIDENCE_REFERENCE":
      return "EVIDENCE_REFERENCE";
    case "PLAN_DEPENDENCY_CYCLE":
    case "PLAN_DEPENDENCY_MISSING":
      return "PLAN_DEPENDENCY";
    case "PLAN_RESOURCE_BUDGET_EXCEEDED":
    case "PLAN_RESOURCE_UNESTIMATED":
      return "PLAN_RESOURCE";
    case "PLAN_QUALITY_BELOW_THRESHOLD":
      return "PLAN_QUALITY";
    case "ACCEPTANCE_CRITERION_UNBOUND":
    case "ACCEPTANCE_CRITERION_BINDING_INVALID":
      return "VERIFICATION_BINDING";
    case "RECOVERY_TARGET_INVALID":
      return "RECOVERY_TARGET_GATE";
    case "RECOVERY_TARGET_BINDING_FAILED":
      return "RECOVERY_TARGET_BINDING";
    default:
      return "PLANNING_VALIDATION";
  }
}

function schemaIssues(error: ZodError): RevisionFailureSchemaIssue[] {
  return error.issues.slice(0, MAX_SCHEMA_ISSUES).map((issue) => ({
    path: issue.path
      .map((segment) =>
        typeof segment === "number"
          ? String(segment)
          : SAFE_PATH_SEGMENT.test(segment)
            ? segment
            : "*",
      )
      .join("."),
    code: safeCode(issue.code) ?? "invalid",
  }));
}

/**
 * Classifies a failure raised while validating/binding/compiling a revised
 * proposal (the REVISION_COMPILATION_FAILED stage).
 */
export function classifyRevisionCompilationFailure(
  error: unknown,
): RevisionFailureCause {
  if (isPlanningError(error)) {
    return {
      causeClass: planningCauseClass(error.code),
      causeCode: error.code,
      planningCode: error.code,
    };
  }
  if (isRecoveryTargetBinderError(error)) {
    return {
      causeClass: "RECOVERY_TARGET_BINDING",
      causeCode: error.code,
      binderCode: error.code,
    };
  }
  if (isValidationError(error)) {
    const declaredClass = error.details["causeClass"];
    const declaredCode = safeCode(error.details["causeCode"]);
    if (isCauseClass(declaredClass) && declaredCode) {
      return { causeClass: declaredClass, causeCode: declaredCode };
    }
    const binderCode = safeCode(error.details["binderCode"]);
    if (binderCode) {
      return {
        causeClass: "RECOVERY_TARGET_BINDING",
        causeCode: binderCode,
        binderCode,
      };
    }
    return { causeClass: "REVISION_PROCESS", causeCode: error.code };
  }
  if (error instanceof ZodError) {
    return {
      causeClass: "PLAN_SCHEMA",
      causeCode: "PLAN_SCHEMA_INVALID",
      schemaIssues: schemaIssues(error),
    };
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? safeCode((error as { code: unknown }).code)
      : undefined;
  const name = error instanceof Error ? safeCode(error.name) : undefined;
  return {
    causeClass: "INFRASTRUCTURE",
    causeCode: code ?? name ?? "UNKNOWN",
  };
}

export function revisionFailureCauseDetails(
  cause: RevisionFailureCause,
): Record<string, unknown> {
  return {
    causeClass: cause.causeClass,
    causeCode: cause.causeCode,
    ...(cause.planningCode !== undefined
      ? { planningCode: cause.planningCode }
      : {}),
    ...(cause.binderCode !== undefined ? { binderCode: cause.binderCode } : {}),
    ...(cause.schemaIssues !== undefined
      ? { schemaIssues: cause.schemaIssues }
      : {}),
  };
}

function revisionProcessCauseClass(code: string): RevisionFailureCauseClass {
  if (code === "REVISION_BUDGET_EXCEEDED") {
    return "REVISION_BUDGET";
  }
  if (code.startsWith("REVISION_MODEL") || code.startsWith("VALIDATION_MODEL")) {
    return "REVISION_MODEL";
  }
  return "REVISION_PROCESS";
}

/**
 * Sanitized metadata for the REVISION_FAILED finding. Raw error details are
 * reduced to allow-listed identifier/code keys; free-text causes are dropped.
 */
export function revisionFailureFindingMetadata(
  failure: ValidationError | null,
): Record<string, unknown> {
  const code = failure?.code ?? "REVISION_FAILED";
  const details: Readonly<Record<string, unknown>> = failure?.details ?? {};
  const declaredClass = details["causeClass"];
  const causeClass = isCauseClass(declaredClass)
    ? declaredClass
    : revisionProcessCauseClass(code);
  const causeCode = safeCode(details["causeCode"]) ?? code;

  const safeDetails: Record<string, unknown> = {};
  for (const key of SAFE_DETAIL_KEYS) {
    const value = details[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      safeDetails[key] = value;
    } else if (typeof value === "string" && SAFE_IDENTIFIER.test(value)) {
      safeDetails[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every(
        (entry) => typeof entry === "string" && SAFE_IDENTIFIER.test(entry),
      )
    ) {
      safeDetails[key] = [...value];
    }
  }

  const planningCode = safeCode(details["planningCode"]);
  const binderCode = safeCode(details["binderCode"]);
  const rawIssues = details["schemaIssues"];
  const issues = Array.isArray(rawIssues)
    ? rawIssues
        .slice(0, MAX_SCHEMA_ISSUES)
        .flatMap((issue: unknown): RevisionFailureSchemaIssue[] => {
          if (typeof issue !== "object" || issue === null) {
            return [];
          }
          const { path, code: issueCode } = issue as Record<string, unknown>;
          return typeof path === "string" &&
            SAFE_SCHEMA_PATH.test(path) &&
            safeCode(issueCode)
            ? [{ path, code: issueCode as string }]
            : [];
        })
    : undefined;

  return {
    code,
    causeClass,
    causeCode,
    ...(planningCode !== undefined ? { planningCode } : {}),
    ...(binderCode !== undefined ? { binderCode } : {}),
    ...(issues !== undefined ? { schemaIssues: issues } : {}),
    details: safeDetails,
  };
}
