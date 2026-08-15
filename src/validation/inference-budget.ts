import type { ResourceBudgetProfile } from "../control-plane/budgets/budget.js";
import { ValidationError } from "./errors.js";
import {
  aggregateValidationUsage,
  VALIDATION_OPERATION_CATEGORY,
  type ValidationModelOperation,
  type ValidationUsageAggregate,
  type ValidationUsageLedger,
} from "./model.js";
import { computeTokenReservation } from "./token-reservation.js";

/**
 * Deterministic validation/revision inference budget enforcement.
 *
 * Ceiling: the run's hard ResourceBudgetProfile fields
 * `maximumLlmCalls` and `maximumTotalTokens`. There is no dedicated revision
 * token field — SEMANTIC_REVISION is a distinct sub-category on
 * ValidationUsageLedger, not an inventable extra budget.
 *
 * Planning (INITIAL_PLANNING) is metered on PlanningUsageLedger and cannot be
 * borrowed from here. Contextual validation and semantic revision share this
 * ledger but are always tagged with an explicit operation/category.
 *
 * remaining =
 *   maximumTotalTokens - completedActualTokens - activeReservedTokens
 */
export class ValidationInferenceBudget {
  constructor(private readonly ledger: ValidationUsageLedger) {}

  async aggregate(runId: string): Promise<ValidationUsageAggregate> {
    const records = await this.ledger.listByRunId(runId);
    return aggregateValidationUsage(records);
  }

  remainingTokens(
    aggregate: ValidationUsageAggregate,
    budget: ResourceBudgetProfile,
  ): number {
    return (
      budget.maximumTotalTokens -
      aggregate.completedActualTokens -
      aggregate.activeReservedTokens
    );
  }

  async assertCanReserve(input: {
    runId: string;
    budget: ResourceBudgetProfile;
    inputTokenEstimate: number;
    maxOutputTokens: number;
    operation: ValidationModelOperation;
  }): Promise<{
    aggregate: ValidationUsageAggregate;
    reservedTokens: number;
    remaining: number;
  }> {
    if (await this.ledger.hasBudgetInvariantViolation(input.runId)) {
      throw new ValidationError(
        "VALIDATION_MODEL_BUDGET_INVARIANT_VIOLATION",
        "Validation inference budget invariant previously violated; further model calls are blocked",
        { runId: input.runId },
      );
    }

    const aggregate = await this.aggregate(input.runId);
    const reservedTokens = computeTokenReservation({
      inputTokenEstimate: input.inputTokenEstimate,
      maxOutputTokens: input.maxOutputTokens,
    });
    const remaining = this.remainingTokens(aggregate, input.budget);
    const category = VALIDATION_OPERATION_CATEGORY[input.operation];
    const budgetCode =
      input.operation === "PLAN_REVISION"
        ? "REVISION_BUDGET_EXCEEDED"
        : "VALIDATION_MODEL_BUDGET_EXCEEDED";

    if (aggregate.llmCalls >= input.budget.maximumLlmCalls) {
      throw new ValidationError(
        budgetCode,
        input.operation === "PLAN_REVISION"
          ? "Semantic revision LLM call budget exhausted"
          : "Validation inference LLM call budget exhausted",
        {
          dimension: "maximumLlmCalls",
          used: aggregate.llmCalls,
          limit: input.budget.maximumLlmCalls,
          budgetProfileId: input.budget.budgetProfileId,
          operation: input.operation,
          operationCategory: category,
        },
      );
    }

    if (reservedTokens > remaining) {
      throw new ValidationError(
        budgetCode,
        input.operation === "PLAN_REVISION"
          ? "Semantic revision token reservation exceeds remaining budget"
          : "Validation inference token reservation exceeds remaining budget",
        {
          dimension: "maximumTotalTokens",
          requiredReservation: reservedTokens,
          remaining,
          completedActualTokens: aggregate.completedActualTokens,
          activeReservedTokens: aggregate.activeReservedTokens,
          limit: input.budget.maximumTotalTokens,
          budgetProfileId: input.budget.budgetProfileId,
          operation: input.operation,
          operationCategory: category,
        },
      );
    }

    return { aggregate, reservedTokens, remaining };
  }
}
