import { z } from "zod";
import {
  ValidationDecisionClassSchema,
  ValidationFindingSeveritySchema,
} from "../domain/validation/index.js";
import { ValidationError } from "./errors.js";

/**
 * Advisory contextual assessment produced by the validation model.
 *
 * `recommendation` is a recommendation, not a decision: `ValidationDecisionEngine`
 * owns the authoritative decision class. The model cannot approve, cannot
 * declare a violation unrepairable, and cannot clear a deterministic finding.
 */
export const ContextualValidationObservationSchema = z
  .object({
    ruleId: z.string().min(1),
    category: z.string().min(1),
    severity: ValidationFindingSeveritySchema,
    message: z.string().min(1),
    affectedStepIds: z.array(z.string()),
    evidenceRefs: z.array(z.string()),
    repairable: z.boolean(),
    rationale: z.string().min(1),
  })
  .strict();
export type ContextualValidationObservation = z.infer<
  typeof ContextualValidationObservationSchema
>;

export const ContextualValidationAssessmentSchema = z
  .object({
    recommendation: ValidationDecisionClassSchema,
    confidence: z.number().min(0).max(1),
    observations: z.array(ContextualValidationObservationSchema),
    unsupportedClaims: z.array(z.string()),
    coverageGaps: z.array(z.string()),
    summary: z.string().min(1),
  })
  .strict();
export type ContextualValidationAssessment = z.infer<
  typeof ContextualValidationAssessmentSchema
>;

export function parseContextualValidationAssessment(
  input: unknown,
): ContextualValidationAssessment {
  return ContextualValidationAssessmentSchema.parse(input);
}

export interface ValidationModelTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ValidationModelOutput<T> {
  value: T;
  usage?: ValidationModelTokenUsage;
}

export interface ValidationModelInput {
  /** Serialized plan under validation (never re-hashed by the model). */
  plan: unknown;
  /** Deterministic findings already established, as read-only context. */
  deterministicFindings: readonly unknown[];
  /** Compiled planning context: objective, control plane, repository, evidence. */
  context: unknown;
  promptVersion: string;
}

/**
 * Provider-independent validation model port.
 *
 * Deliberately separate from `PlanningModel`: the validator must be able to run
 * a different provider, model, prompt, and budget than the planner, and must
 * never be satisfied by the planner's own reasoning.
 */
export interface ValidationModel {
  readonly provider: string;
  readonly modelId: string;
  readonly toolsEnabled: false;

  validatePlan(
    input: ValidationModelInput,
  ): Promise<ValidationModelOutput<ContextualValidationAssessment>>;
}

export type ValidationModelOperation =
  | "CONTEXTUAL_ASSESSMENT"
  | "PLAN_REVISION";

/**
 * Distinct inference categories across Phases 4–5.
 * Planning uses its own ledger (INITIAL_PLANNING). Validation and revision
 * share `ValidationUsageLedger` but are never ambiguously mixed: every record
 * carries an explicit `operation` mapped to one of these categories.
 */
export type InferenceOperationCategory =
  | "INITIAL_PLANNING"
  | "CONTEXTUAL_VALIDATION"
  | "SEMANTIC_REVISION";

export const VALIDATION_OPERATION_CATEGORY = {
  CONTEXTUAL_ASSESSMENT: "CONTEXTUAL_VALIDATION",
  PLAN_REVISION: "SEMANTIC_REVISION",
} as const satisfies Record<
  ValidationModelOperation,
  Exclude<InferenceOperationCategory, "INITIAL_PLANNING">
>;

export type ValidationModelUsageStatus =
  | "STARTED"
  | "SUCCESS"
  | "FAILED"
  | "TIMEOUT"
  | "REFUSED"
  | "RELEASED";

/**
 * Authoritative Phase 5 validation/revision inference usage record.
 * Distinct from the Phase 4 planning ledger and from the plan's own estimate of
 * future execution cost.
 *
 * Both CONTEXTUAL_ASSESSMENT and PLAN_REVISION draw against the same hard
 * ResourceBudgetProfile ceilings (`maximumLlmCalls`, `maximumTotalTokens`) on
 * this ledger. There is no dedicated revision token field: revision is a
 * distinct sub-category (`SEMANTIC_REVISION`), not a separate inventable budget.
 */
export interface ValidationModelUsage {
  callId: string;
  runId: string;
  planId: string;
  planVersion: number;
  validationAttempt: number;
  operation: ValidationModelOperation;
  /** Always derived from `operation`; never ambiguous. */
  operationCategory: Exclude<
    InferenceOperationCategory,
    "INITIAL_PLANNING"
  >;
  provider: string;
  model: string;
  reservedTokens: number;
  /** Present when operation === PLAN_REVISION. */
  sourcePlanVersion?: number;
  /** Present when operation === PLAN_REVISION. */
  targetPlanVersion?: number;
  /** Present when operation === PLAN_REVISION (1-based attempt index). */
  revisionAttempt?: number;
  inputUsage?: number;
  outputUsage?: number;
  totalUsage?: number;
  startedAt: string;
  completedAt?: string;
  status: ValidationModelUsageStatus;
  budgetInvariantViolation?: boolean;
  charging?: "ACTUAL" | "RESERVATION" | "NONE";
}

export interface ValidationUsageAggregate {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  completedActualTokens: number;
  activeReservedTokens: number;
  budgetInvariantViolated: boolean;
  /** Sub-totals by explicit operation category. */
  byCategory: {
    CONTEXTUAL_VALIDATION: ValidationUsageCategoryTotals;
    SEMANTIC_REVISION: ValidationUsageCategoryTotals;
  };
}

export interface ValidationUsageCategoryTotals {
  llmCalls: number;
  completedActualTokens: number;
  activeReservedTokens: number;
  totalTokens: number;
}

export interface ValidationTokenReservationRequest {
  callId: string;
  runId: string;
  planId: string;
  planVersion: number;
  validationAttempt: number;
  operation: ValidationModelOperation;
  provider: string;
  model: string;
  reservedTokens: number;
  startedAt: string;
  maximumLlmCalls: number;
  maximumTotalTokens: number;
  budgetProfileId: string;
  sourcePlanVersion?: number;
  targetPlanVersion?: number;
  revisionAttempt?: number;
}

export type ValidationUsageSettle =
  | {
      outcome: "SUCCESS" | "FAILED" | "TIMEOUT" | "REFUSED";
      completedAt: string;
      charging: "ACTUAL";
      inputUsage?: number;
      outputUsage?: number;
      totalUsage: number;
      markInvariantViolation?: boolean;
    }
  | {
      outcome: "SUCCESS" | "FAILED" | "TIMEOUT" | "REFUSED";
      completedAt: string;
      charging: "RESERVATION";
    }
  | {
      outcome: "RELEASED";
      completedAt: string;
      charging: "NONE";
      reason: "PRE_DISPATCH_FAILURE";
    };

/**
 * Validation-inference usage ledger.
 *
 * `reserve` must be atomic with respect to other reservations for the same run.
 * The in-memory implementation provides process-local atomicity only; durable
 * implementations require transactional or compare-and-swap reservation.
 */
export interface ValidationUsageLedger {
  reserve(
    request: ValidationTokenReservationRequest,
  ): Promise<ValidationModelUsage>;
  settle(
    callId: string,
    update: ValidationUsageSettle,
  ): Promise<ValidationModelUsage>;
  listByRunId(runId: string): Promise<readonly ValidationModelUsage[]>;
  hasBudgetInvariantViolation(runId: string): Promise<boolean>;
}

export function aggregateValidationUsage(
  records: readonly ValidationModelUsage[],
): ValidationUsageAggregate {
  let inputTokens = 0;
  let outputTokens = 0;
  let completedActualTokens = 0;
  let activeReservedTokens = 0;
  let llmCalls = 0;
  let budgetInvariantViolated = false;
  const byCategory = {
    CONTEXTUAL_VALIDATION: emptyCategoryTotals(),
    SEMANTIC_REVISION: emptyCategoryTotals(),
  };

  for (const record of records) {
    if (record.budgetInvariantViolation) {
      budgetInvariantViolated = true;
    }
    if (record.status === "RELEASED") {
      continue;
    }
    const category = record.operationCategory;
    llmCalls += 1;
    byCategory[category].llmCalls += 1;
    if (record.status === "STARTED") {
      activeReservedTokens += record.reservedTokens;
      byCategory[category].activeReservedTokens += record.reservedTokens;
      byCategory[category].totalTokens += record.reservedTokens;
      continue;
    }
    const charged = record.totalUsage ?? 0;
    completedActualTokens += charged;
    byCategory[category].completedActualTokens += charged;
    byCategory[category].totalTokens += charged;
    inputTokens += record.inputUsage ?? 0;
    outputTokens += record.outputUsage ?? 0;
  }

  return {
    llmCalls,
    inputTokens,
    outputTokens,
    completedActualTokens,
    activeReservedTokens,
    totalTokens: completedActualTokens + activeReservedTokens,
    budgetInvariantViolated,
    byCategory,
  };
}

function emptyCategoryTotals(): ValidationUsageCategoryTotals {
  return {
    llmCalls: 0,
    completedActualTokens: 0,
    activeReservedTokens: 0,
    totalTokens: 0,
  };
}

export function resolveValidationChargedTokenTotal(
  usage: ValidationModelTokenUsage | undefined,
): number | undefined {
  if (!usage) {
    return undefined;
  }
  if (typeof usage.totalTokens === "number") {
    return usage.totalTokens;
  }
  if (
    typeof usage.inputTokens === "number" ||
    typeof usage.outputTokens === "number"
  ) {
    return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }
  return undefined;
}

export class InMemoryValidationUsageLedger implements ValidationUsageLedger {
  private readonly byCallId = new Map<string, ValidationModelUsage>();
  private readonly invariantRuns = new Set<string>();
  private readonly runLocks = new Map<string, Promise<unknown>>();

  private async withRunLock<T>(
    runId: string,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const previous = this.runLocks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.runLocks.set(
      runId,
      previous.catch(() => undefined).then(() => gate),
    );
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private recordsForRun(runId: string): ValidationModelUsage[] {
    return [...this.byCallId.values()].filter(
      (record) => record.runId === runId,
    );
  }

  async reserve(
    request: ValidationTokenReservationRequest,
  ): Promise<ValidationModelUsage> {
    return this.withRunLock(request.runId, () => {
      if (this.byCallId.has(request.callId)) {
        throw new Error(
          `Validation usage callId already exists: ${request.callId}`,
        );
      }
      if (
        this.invariantRuns.has(request.runId) ||
        this.recordsForRun(request.runId).some(
          (record) => record.budgetInvariantViolation,
        )
      ) {
        throw new ValidationError(
          "VALIDATION_MODEL_BUDGET_INVARIANT_VIOLATION",
          "Validation inference budget invariant previously violated; further model calls are blocked",
          { runId: request.runId },
        );
      }

      const aggregate = aggregateValidationUsage(
        this.recordsForRun(request.runId),
      );

      if (aggregate.llmCalls >= request.maximumLlmCalls) {
        throw new ValidationError(
          request.operation === "PLAN_REVISION"
            ? "REVISION_BUDGET_EXCEEDED"
            : "VALIDATION_MODEL_BUDGET_EXCEEDED",
          request.operation === "PLAN_REVISION"
            ? "Semantic revision LLM call budget exhausted"
            : "Validation inference LLM call budget exhausted",
          {
            dimension: "maximumLlmCalls",
            used: aggregate.llmCalls,
            limit: request.maximumLlmCalls,
            budgetProfileId: request.budgetProfileId,
            operation: request.operation,
            operationCategory: VALIDATION_OPERATION_CATEGORY[request.operation],
          },
        );
      }

      const remaining =
        request.maximumTotalTokens -
        aggregate.completedActualTokens -
        aggregate.activeReservedTokens;

      if (request.reservedTokens > remaining) {
        throw new ValidationError(
          request.operation === "PLAN_REVISION"
            ? "REVISION_BUDGET_EXCEEDED"
            : "VALIDATION_MODEL_BUDGET_EXCEEDED",
          request.operation === "PLAN_REVISION"
            ? "Semantic revision token reservation exceeds remaining budget"
            : "Validation inference token reservation exceeds remaining budget",
          {
            dimension: "maximumTotalTokens",
            requiredReservation: request.reservedTokens,
            remaining,
            completedActualTokens: aggregate.completedActualTokens,
            activeReservedTokens: aggregate.activeReservedTokens,
            limit: request.maximumTotalTokens,
            budgetProfileId: request.budgetProfileId,
            operation: request.operation,
            operationCategory: VALIDATION_OPERATION_CATEGORY[request.operation],
          },
        );
      }

      const record: ValidationModelUsage = {
        callId: request.callId,
        runId: request.runId,
        planId: request.planId,
        planVersion: request.planVersion,
        validationAttempt: request.validationAttempt,
        operation: request.operation,
        operationCategory: VALIDATION_OPERATION_CATEGORY[request.operation],
        provider: request.provider,
        model: request.model,
        reservedTokens: request.reservedTokens,
        startedAt: request.startedAt,
        status: "STARTED",
      };
      if (request.sourcePlanVersion !== undefined) {
        record.sourcePlanVersion = request.sourcePlanVersion;
      }
      if (request.targetPlanVersion !== undefined) {
        record.targetPlanVersion = request.targetPlanVersion;
      }
      if (request.revisionAttempt !== undefined) {
        record.revisionAttempt = request.revisionAttempt;
      }
      this.byCallId.set(request.callId, record);
      return { ...record };
    });
  }

  async settle(
    callId: string,
    update: ValidationUsageSettle,
  ): Promise<ValidationModelUsage> {
    const existing = this.byCallId.get(callId);
    if (!existing) {
      throw new Error(`Unknown validation usage callId: ${callId}`);
    }
    return this.withRunLock(existing.runId, () => {
      const current = this.byCallId.get(callId);
      if (!current) {
        throw new Error(`Unknown validation usage callId: ${callId}`);
      }
      if (current.status !== "STARTED") {
        throw new Error(
          `Validation usage callId ${callId} already settled as ${current.status}`,
        );
      }

      if (update.charging === "NONE") {
        const released: ValidationModelUsage = {
          ...current,
          status: "RELEASED",
          completedAt: update.completedAt,
          charging: "NONE",
          totalUsage: 0,
        };
        this.byCallId.set(callId, released);
        return { ...released };
      }

      if (update.charging === "RESERVATION") {
        const settled: ValidationModelUsage = {
          ...current,
          status: update.outcome,
          completedAt: update.completedAt,
          charging: "RESERVATION",
          totalUsage: current.reservedTokens,
        };
        this.byCallId.set(callId, settled);
        return { ...settled };
      }

      const settled: ValidationModelUsage = {
        ...current,
        status: update.outcome,
        completedAt: update.completedAt,
        charging: "ACTUAL",
        totalUsage: update.totalUsage,
      };
      if (update.inputUsage !== undefined) {
        settled.inputUsage = update.inputUsage;
      }
      if (update.outputUsage !== undefined) {
        settled.outputUsage = update.outputUsage;
      }
      if (update.markInvariantViolation) {
        settled.budgetInvariantViolation = true;
        this.invariantRuns.add(current.runId);
      }
      this.byCallId.set(callId, settled);
      return { ...settled };
    });
  }

  async listByRunId(runId: string): Promise<readonly ValidationModelUsage[]> {
    return this.recordsForRun(runId);
  }

  async hasBudgetInvariantViolation(runId: string): Promise<boolean> {
    if (this.invariantRuns.has(runId)) {
      return true;
    }
    return this.recordsForRun(runId).some(
      (record) => record.budgetInvariantViolation === true,
    );
  }
}
