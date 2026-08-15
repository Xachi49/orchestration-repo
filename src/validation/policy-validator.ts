import type {
  PolicyBundle,
  PolicyCondition,
  PolicyRule,
} from "../control-plane/policies/policy.js";
import type { ProjectControlContext } from "../control-plane/context.js";
import type { ExecutionPlan, ExecutionStep } from "../domain/plan/execution-plan.js";
import type { ValidationFinding } from "../domain/validation/index.js";
import { ValidationFindingFactory } from "./finding-factory.js";

export type PolicyAttributes = Readonly<
  Record<string, string | readonly string[]>
>;

export type PolicyConditionOutcome =
  | "SATISFIED"
  | "UNSATISFIED"
  | "INDETERMINATE";

export type PolicyStepEffect =
  | "DENY"
  | "REQUIRE_APPROVAL"
  | "ALLOW"
  | "NO_MATCHING_RULE";

export interface PolicyStepEvaluation {
  stepId: string;
  actionType: string;
  effect: PolicyStepEffect;
  matchedRuleIds: readonly string[];
  reasonCodes: readonly string[];
}

export interface PlanPolicyValidatorInput {
  plan: ExecutionPlan;
  control: ProjectControlContext;
  environment: string;
}

export interface PlanPolicyValidationResult {
  findings: readonly ValidationFinding[];
  evaluations: readonly PolicyStepEvaluation[];
}

/**
 * Deterministic evaluation of stored `PolicyBundle` rules against plan steps.
 *
 * Deny-overrides: `DENY` beats `REQUIRE_APPROVAL` beats `ALLOW`. A step matched
 * by no rule is not permitted by default — configuration authority never
 * implies a grant.
 *
 * Conditions are exact-match `EQ`/`NEQ`/`IN`/`NOT_IN` over simple attributes.
 * A condition referencing an attribute the plan does not expose is
 * indeterminate: it cannot satisfy an `ALLOW`, and it does not excuse a
 * restrictive rule.
 */
export class PlanPolicyValidator {
  constructor(
    private readonly findings: ValidationFindingFactory = new ValidationFindingFactory(),
  ) {}

  buildStepAttributes(input: {
    step: ExecutionStep;
    plan: ExecutionPlan;
    control: ProjectControlContext;
    environment: string;
  }): PolicyAttributes {
    return {
      stepId: input.step.stepId,
      actionType: input.step.actionType,
      environment: input.environment,
      executionMode: input.control.project.executionMode,
      projectId: input.control.project.projectId,
      sensitivityClassification: input.control.project.sensitivityClassification,
      riskLevel: input.step.risk.level,
      riskCategories: [...input.step.risk.categories],
      rollbackStrategy: input.step.rollback.strategy,
      targetIds: [...input.step.targetIds],
      objectiveId: input.plan.objectiveId,
      policyBundleId: input.plan.policyBundleId,
    };
  }

  evaluateCondition(
    condition: PolicyCondition,
    attributes: PolicyAttributes,
  ): PolicyConditionOutcome {
    const actual = attributes[condition.attribute];
    if (actual === undefined) {
      return "INDETERMINATE";
    }
    const actualValues: string[] =
      typeof actual === "string" ? [actual] : [...actual];
    const expected: string[] =
      typeof condition.value === "string"
        ? [condition.value]
        : [...condition.value];
    const intersects = actualValues.some((value) => expected.includes(value));

    switch (condition.operator) {
      case "EQ":
      case "IN":
        return intersects ? "SATISFIED" : "UNSATISFIED";
      case "NEQ":
      case "NOT_IN":
        return intersects ? "UNSATISFIED" : "SATISFIED";
      default:
        return "INDETERMINATE";
    }
  }

  private ruleApplies(input: {
    rule: PolicyRule;
    actionType: string;
    environment: string;
    attributes: PolicyAttributes;
  }): { applies: boolean; indeterminate: boolean } {
    const { rule } = input;
    if (
      rule.environments.length > 0 &&
      !rule.environments.includes(input.environment)
    ) {
      return { applies: false, indeterminate: false };
    }
    if (
      rule.actionTypes.length > 0 &&
      !rule.actionTypes.includes(input.actionType)
    ) {
      return { applies: false, indeterminate: false };
    }

    let indeterminate = false;
    for (const condition of rule.conditions) {
      const outcome = this.evaluateCondition(condition, input.attributes);
      if (outcome === "UNSATISFIED") {
        return { applies: false, indeterminate: false };
      }
      if (outcome === "INDETERMINATE") {
        indeterminate = true;
      }
    }

    if (indeterminate && rule.effect === "ALLOW") {
      return { applies: false, indeterminate: true };
    }
    return { applies: true, indeterminate };
  }

  evaluateStep(input: {
    step: ExecutionStep;
    plan: ExecutionPlan;
    control: ProjectControlContext;
    environment: string;
    bundle: PolicyBundle;
  }): PolicyStepEvaluation {
    const attributes = this.buildStepAttributes({
      step: input.step,
      plan: input.plan,
      control: input.control,
      environment: input.environment,
    });

    const denies: PolicyRule[] = [];
    const approvals: PolicyRule[] = [];
    const allows: PolicyRule[] = [];

    for (const rule of input.bundle.rules) {
      const { applies } = this.ruleApplies({
        rule,
        actionType: input.step.actionType,
        environment: input.environment,
        attributes,
      });
      if (!applies) {
        continue;
      }
      if (rule.effect === "DENY") {
        denies.push(rule);
      } else if (rule.effect === "REQUIRE_APPROVAL") {
        approvals.push(rule);
      } else {
        allows.push(rule);
      }
    }

    const matched = denies.length > 0 ? denies : approvals.length > 0 ? approvals : allows;
    const effect: PolicyStepEffect =
      denies.length > 0
        ? "DENY"
        : approvals.length > 0
          ? "REQUIRE_APPROVAL"
          : allows.length > 0
            ? "ALLOW"
            : "NO_MATCHING_RULE";

    return {
      stepId: input.step.stepId,
      actionType: input.step.actionType,
      effect,
      matchedRuleIds: matched.map((rule) => rule.ruleId),
      reasonCodes: matched.map((rule) => rule.reasonCode),
    };
  }

  validate(input: PlanPolicyValidatorInput): PlanPolicyValidationResult {
    const bundle = input.control.activePolicyBundle;
    const results: ValidationFinding[] = [];

    if (bundle.status !== "ACTIVE") {
      results.push(
        this.findings.create({
          validatorType: "POLICY",
          category: "policy-authority",
          severity: "CRITICAL",
          ruleId: "POLICY_BUNDLE_NOT_ACTIVE",
          message: `Active policy bundle is ${bundle.status}`,
          repairable: false,
          approvalEligible: false,
          blocking: true,
          subject: { status: bundle.status },
        }),
      );
    }

    const evaluations = input.plan.steps.map((step) =>
      this.evaluateStep({
        step,
        plan: input.plan,
        control: input.control,
        environment: input.environment,
        bundle,
      }),
    );

    for (const evaluation of evaluations) {
      if (evaluation.effect === "DENY") {
        results.push(
          this.findings.create({
            validatorType: "POLICY",
            category: "policy-decision",
            severity: "CRITICAL",
            ruleId: "POLICY_DENY",
            message: `Policy denies action ${evaluation.actionType} for step ${evaluation.stepId}`,
            repairable: false,
            approvalEligible: false,
            blocking: true,
            affectedStepIds: [evaluation.stepId],
            subject: {
              actionType: evaluation.actionType,
              reasonCodes: [...evaluation.reasonCodes],
            },
            metadata: {
              matchedRuleIds: [...evaluation.matchedRuleIds],
              reasonCodes: [...evaluation.reasonCodes],
            },
          }),
        );
        continue;
      }
      if (evaluation.effect === "REQUIRE_APPROVAL") {
        results.push(
          this.findings.create({
            validatorType: "POLICY",
            category: "policy-decision",
            severity: "WARNING",
            ruleId: "POLICY_APPROVAL_REQUIRED",
            message: `Policy requires human approval for action ${evaluation.actionType}`,
            repairable: false,
            approvalEligible: true,
            blocking: false,
            affectedStepIds: [evaluation.stepId],
            subject: {
              actionType: evaluation.actionType,
              reasonCodes: [...evaluation.reasonCodes],
            },
            metadata: {
              matchedRuleIds: [...evaluation.matchedRuleIds],
              reasonCodes: [...evaluation.reasonCodes],
            },
          }),
        );
        continue;
      }
      if (evaluation.effect === "NO_MATCHING_RULE") {
        results.push(
          this.findings.create({
            validatorType: "POLICY",
            category: "policy-decision",
            severity: "ERROR",
            ruleId: "POLICY_NO_MATCHING_RULE",
            message: `No policy rule permits action ${evaluation.actionType}; configuration authority never implies a grant`,
            repairable: true,
            approvalEligible: false,
            blocking: true,
            affectedStepIds: [evaluation.stepId],
            subject: { actionType: evaluation.actionType },
          }),
        );
      }
    }

    return { findings: results, evaluations };
  }
}
