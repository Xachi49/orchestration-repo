import {
  compareBudget,
} from "../control-plane/budgets/compare.js";
import type {
  BudgetDimension,
  BudgetResourceEstimate,
  ResourceBudgetProfile,
} from "../control-plane/budgets/budget.js";
import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import type { ValidationFinding } from "../domain/validation/index.js";
import { ValidationFindingFactory } from "./finding-factory.js";

/**
 * Dimensions designated hard / non-overrideable.
 *
 * A hard exceed is a blocking, non-repairable, non-approval-eligible violation:
 * neither a semantic revision nor a human approver may override it. Remaining
 * dimensions are overrideable and route to human approval instead.
 */
export const HARD_BUDGET_DIMENSIONS = [
  "llmCalls",
  "totalTokens",
  "apiCalls",
  "estimatedCost",
  "planSteps",
  "parallelWorkstreams",
] as const satisfies readonly BudgetDimension[];

export type HardBudgetDimension = (typeof HARD_BUDGET_DIMENSIONS)[number];

export interface PlanResourceValidatorInput {
  plan: ExecutionPlan;
  budget: ResourceBudgetProfile;
}

export interface PlanResourceValidationResult {
  findings: readonly ValidationFinding[];
  estimate: BudgetResourceEstimate;
  classification: "WITHIN_BUDGET" | "BUDGET_EXCEEDED" | "UNESTIMATED_RESOURCE";
}

/**
 * Independent recomputation of the plan's declared future execution cost.
 *
 * Totals are re-derived from the compiled steps rather than trusted from the
 * proposal, then compared against the configured ceilings.
 */
export class PlanResourceValidator {
  private readonly hardDimensions: ReadonlySet<string>;

  constructor(
    private readonly findings: ValidationFindingFactory = new ValidationFindingFactory(),
    hardDimensions: readonly BudgetDimension[] = HARD_BUDGET_DIMENSIONS,
  ) {
    this.hardDimensions = new Set(hardDimensions);
  }

  deriveEstimate(plan: ExecutionPlan): BudgetResourceEstimate {
    const stepTokens = plan.steps.reduce(
      (sum, step) => sum + (step.resourceEstimate.tokenEstimate ?? 0),
      0,
    );
    const stepDurationMs = plan.steps.reduce(
      (sum, step) => sum + (step.resourceEstimate.durationMs ?? 0),
      0,
    );
    const stepCost = plan.steps.reduce(
      (sum, step) => sum + (step.resourceEstimate.costEstimateUsd ?? 0),
      0,
    );

    return {
      llmCalls: 0,
      totalTokens: Math.max(plan.resourceTotals.tokenEstimate ?? 0, stepTokens),
      apiCalls: 0,
      executionMinutes: Math.ceil(
        Math.max(plan.resourceTotals.durationMs ?? 0, stepDurationMs) / 60_000,
      ),
      estimatedCost: Math.max(
        plan.resourceTotals.costEstimateUsd ?? 0,
        stepCost,
      ),
      humanReviewMinutes: 0,
      planSteps: plan.steps.length,
      parallelWorkstreams: plan.workstreams.length,
      revisionAttempts: Math.max(0, plan.planVersion - 1),
    };
  }

  validate(input: PlanResourceValidatorInput): PlanResourceValidationResult {
    const estimate = this.deriveEstimate(input.plan);
    const results: ValidationFinding[] = [];

    const unestimatedSteps = input.plan.steps
      .filter(
        (step) =>
          step.resourceEstimate.tokenEstimate === undefined &&
          step.resourceEstimate.durationMs === undefined &&
          step.resourceEstimate.costEstimateUsd === undefined,
      )
      .map((step) => step.stepId);
    if (unestimatedSteps.length > 0) {
      results.push(
        this.findings.create({
          validatorType: "RESOURCE",
          category: "resource-estimate",
          severity: "ERROR",
          ruleId: "RESOURCE_STEP_UNESTIMATED",
          message: "Plan step carries no resource estimate",
          repairable: true,
          approvalEligible: false,
          blocking: true,
          affectedStepIds: unestimatedSteps,
          subject: { stepIds: unestimatedSteps },
        }),
      );
    }

    const comparison = compareBudget(estimate, input.budget);

    if (comparison.result === "UNESTIMATED_RESOURCE") {
      results.push(
        this.findings.create({
          validatorType: "RESOURCE",
          category: "resource-estimate",
          severity: "ERROR",
          ruleId: "RESOURCE_UNESTIMATED",
          message: "Plan is missing required resource dimensions",
          repairable: true,
          approvalEligible: false,
          blocking: true,
          subject: { dimensions: [...comparison.missing] },
          metadata: { missing: [...comparison.missing] },
        }),
      );
    }

    if (comparison.result === "BUDGET_EXCEEDED") {
      const hard = comparison.exceeded.filter((dimension) =>
        this.hardDimensions.has(dimension),
      );
      const overrideable = comparison.exceeded.filter(
        (dimension) => !this.hardDimensions.has(dimension),
      );

      for (const dimension of hard) {
        results.push(
          this.findings.create({
            validatorType: "RESOURCE",
            category: "resource-budget",
            severity: "CRITICAL",
            ruleId: "RESOURCE_HARD_BUDGET_EXCEEDED",
            message: `Plan exceeds the hard, non-overrideable budget ceiling for ${dimension}`,
            repairable: false,
            approvalEligible: false,
            blocking: true,
            subject: { dimension },
            metadata: {
              dimension,
              estimated: estimate[dimension],
              budgetProfileId: input.budget.budgetProfileId,
            },
          }),
        );
      }

      for (const dimension of overrideable) {
        results.push(
          this.findings.create({
            validatorType: "RESOURCE",
            category: "resource-budget",
            severity: "WARNING",
            ruleId: "RESOURCE_OVERRIDEABLE_BUDGET_EXCEEDED",
            message: `Plan exceeds the overrideable budget ceiling for ${dimension}`,
            repairable: true,
            approvalEligible: true,
            blocking: false,
            subject: { dimension },
            metadata: {
              dimension,
              estimated: estimate[dimension],
              budgetProfileId: input.budget.budgetProfileId,
            },
          }),
        );
      }
    }

    return { findings: results, estimate, classification: comparison.result };
  }
}
