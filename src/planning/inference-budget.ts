import type { ResourceBudgetProfile } from "../control-plane/budgets/budget.js";
import { PlanningError } from "./errors.js";
import {
  aggregatePlanningUsage,
  type PlanningUsageAggregate,
  type PlanningUsageLedger,
} from "./model.js";
import { computeTokenReservation } from "./token-reservation.js";

/**
 * Deterministic planning-inference budget enforcement with token reservation.
 *
 * remaining =
 *   maximumTotalTokens - completedActualTokens - activeReservedTokens
 *
 * Pre-call reservation = compiled input estimate + configured max output tokens.
 * Actual provider usage is never used as the pre-call reservation.
 *
 * Distinct from PlanProposal estimated future execution resources
 * (PlanResourceAnalyzer / PLAN_RESOURCE_BUDGET_EXCEEDED).
 *
 * Phase 4: hard configured limits fail closed. No overrides.
 * Phase 5 may later route explicitly overrideable conditions to
 * HUMAN_APPROVAL_REQUIRED, but must never override a budget designated
 * hard / non-overrideable.
 *
 * Durable ledgers must implement transactional/CAS reservation; the in-memory
 * ledger only guarantees process-local atomicity per runId.
 */
export class PlanningInferenceBudget {
  constructor(private readonly ledger: PlanningUsageLedger) {}

  async aggregate(runId: string): Promise<PlanningUsageAggregate> {
    const records = await this.ledger.listByRunId(runId);
    return aggregatePlanningUsage(records);
  }

  remainingTokens(
    aggregate: PlanningUsageAggregate,
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
  }): Promise<{
    aggregate: PlanningUsageAggregate;
    reservedTokens: number;
    remaining: number;
  }> {
    if (await this.ledger.hasBudgetInvariantViolation(input.runId)) {
      throw new PlanningError(
        "PLANNING_MODEL_BUDGET_INVARIANT_VIOLATION",
        "Planning inference budget invariant previously violated; further model calls are blocked",
        { runId: input.runId },
      );
    }

    const aggregate = await this.aggregate(input.runId);
    const reservedTokens = computeTokenReservation({
      inputTokenEstimate: input.inputTokenEstimate,
      maxOutputTokens: input.maxOutputTokens,
    });
    const remaining = this.remainingTokens(aggregate, input.budget);

    if (aggregate.llmCalls >= input.budget.maximumLlmCalls) {
      throw new PlanningError(
        "PLANNING_MODEL_BUDGET_EXCEEDED",
        "Planning inference LLM call budget exhausted",
        {
          dimension: "maximumLlmCalls",
          used: aggregate.llmCalls,
          limit: input.budget.maximumLlmCalls,
          budgetProfileId: input.budget.budgetProfileId,
        },
      );
    }

    if (reservedTokens > remaining) {
      throw new PlanningError(
        "PLANNING_MODEL_BUDGET_EXCEEDED",
        "Planning inference token reservation exceeds remaining budget",
        {
          dimension: "maximumTotalTokens",
          requiredReservation: reservedTokens,
          remaining,
          completedActualTokens: aggregate.completedActualTokens,
          activeReservedTokens: aggregate.activeReservedTokens,
          limit: input.budget.maximumTotalTokens,
          budgetProfileId: input.budget.budgetProfileId,
        },
      );
    }

    return { aggregate, reservedTokens, remaining };
  }
}
