import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import type { ValidationFinding } from "../domain/validation/index.js";
import { DependencyGraphService } from "../planning/dependency-graph.js";
import type { DependencyGraphResult } from "../planning/dependency-graph.js";
import type { ProposedStep } from "../planning/proposal.js";
import { isPlanningError } from "../planning/errors.js";
import { ValidationFindingFactory } from "./finding-factory.js";

export interface PlanDependencyValidationResult {
  findings: readonly ValidationFinding[];
  graph: DependencyGraphResult | null;
}

/** ExecutionStep → the shape `DependencyGraphService` consumes. */
function toProposedStep(
  step: ExecutionPlan["steps"][number],
): ProposedStep {
  return {
    stepId: step.stepId,
    actionType: step.actionType,
    description: step.description,
    targetIds: [...step.targetIds],
    evidenceRefs: [...step.evidenceRefs],
    dependsOn: [...step.dependsOn],
    preconditions: [...step.preconditions],
    expectedPostconditions: [...step.expectedPostconditions],
    resourceEstimate: { ...step.resourceEstimate },
    risk: {
      level: step.risk.level,
      categories: [...step.risk.categories],
      ...(step.risk.notes !== undefined ? { notes: [...step.risk.notes] } : {}),
    },
    validationChecks: [...step.validation.checks],
    rollbackStrategy: step.rollback.strategy,
    ...(step.rollback.instructions !== undefined
      ? { rollbackInstructions: [...step.rollback.instructions] }
      : {}),
  };
}

/**
 * Re-runs the deterministic dependency analysis against the compiled plan.
 *
 * The planning phase throws on a bad graph; validation must not. Graph defects
 * are returned as structured, repairable findings so a bounded revision can
 * attempt a fix instead of the run failing outright.
 */
export class PlanDependencyValidator {
  constructor(
    private readonly graphs: DependencyGraphService = new DependencyGraphService(),
    private readonly findings: ValidationFindingFactory = new ValidationFindingFactory(),
  ) {}

  validate(plan: ExecutionPlan): PlanDependencyValidationResult {
    const steps = plan.steps.map(toProposedStep);
    let graph: DependencyGraphResult;
    try {
      graph = this.graphs.validate(steps);
    } catch (error) {
      if (!isPlanningError(error)) {
        throw error;
      }
      const stepId =
        typeof error.details["stepId"] === "string"
          ? error.details["stepId"]
          : undefined;
      const ruleId =
        error.code === "PLAN_DEPENDENCY_CYCLE"
          ? "DEPENDENCY_CYCLE"
          : "DEPENDENCY_UNRESOLVED_REFERENCE";
      return {
        graph: null,
        findings: [
          this.findings.create({
            validatorType: "DEPENDENCY",
            category: "plan-graph",
            severity: "ERROR",
            ruleId,
            message: error.message,
            repairable: true,
            approvalEligible: false,
            blocking: true,
            ...(stepId !== undefined ? { affectedStepIds: [stepId] } : {}),
            subject: {
              ...(stepId !== undefined ? { stepId } : {}),
              planningCode: error.code,
            },
            metadata: { planningCode: error.code, ...error.details },
          }),
        ],
      };
    }

    const results: ValidationFinding[] = [];
    const recomputed = graph.criticalPath.join(">");
    const declared = plan.criticalPath.join(">");
    if (recomputed !== declared) {
      results.push(
        this.findings.create({
          validatorType: "DEPENDENCY",
          category: "plan-graph",
          severity: "ERROR",
          ruleId: "DEPENDENCY_CRITICAL_PATH_MISMATCH",
          message:
            "Plan critical path does not match the deterministically recomputed path",
          repairable: true,
          approvalEligible: false,
          blocking: true,
          affectedStepIds: graph.criticalPath,
          subject: { recomputed, declared },
          metadata: { recomputed, declared },
        }),
      );
    }

    return { graph, findings: results };
  }
}
