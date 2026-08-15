import type { ProjectControlContext } from "../control-plane/context.js";
import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import type { ValidationFinding } from "../domain/validation/index.js";
import { ValidationFindingFactory } from "./finding-factory.js";

/** Actions no plan may contain, independent of registry configuration. */
export const FORBIDDEN_ACTION_TYPES = [
  "PUSH_TO_MAIN",
  "FORCE_PUSH",
  "MERGE_PULL_REQUEST",
  "DELETE_REPOSITORY",
  "DELETE_BRANCH",
  "CHANGE_ACCESS_CONTROL",
  "ROTATE_CREDENTIALS",
  "DISABLE_SECURITY_CONTROL",
  "EXECUTE_SHELL",
  "RUN_ARBITRARY_COMMAND",
] as const;

/** Actions that mutate a deployed environment. */
export const DEPLOYMENT_ACTION_TYPES = [
  "DEPLOY_PRODUCTION",
  "DEPLOY",
  "RELEASE",
  "PROMOTE_RELEASE",
] as const;

/** Actions permitted while the project executes in PATCH_ONLY mode. */
export const PATCH_ONLY_MUTATION_ACTIONS = [
  "CREATE_LOCAL_PATCH",
  "PREPARE_PULL_REQUEST",
  "CREATE_TASK",
] as const;

const SECRET_HINTS = [
  ".env",
  "credential",
  "secret",
  "api_key",
  "apikey",
  "private-key",
  "id_rsa",
  "password",
  "access token",
  "github_token",
  "openai_api_key",
];

export interface PlanSecurityValidatorInput {
  plan: ExecutionPlan;
  control: ProjectControlContext;
  environment: string;
}

/**
 * Security adjudication independent of the capability registry.
 *
 * Registry configuration can be edited; this deny-list cannot be satisfied by
 * configuration. Forbidden actions, production deployment, and execution-mode
 * violations are non-repairable: they are not defects a revision may negotiate.
 */
export class PlanSecurityValidator {
  constructor(
    private readonly findings: ValidationFindingFactory = new ValidationFindingFactory(),
  ) {}

  validate(input: PlanSecurityValidatorInput): ValidationFinding[] {
    const results: ValidationFinding[] = [];
    const forbidden = new Set<string>(FORBIDDEN_ACTION_TYPES);
    const deployments = new Set<string>(DEPLOYMENT_ACTION_TYPES);
    const patchOnlyAllowed = new Set<string>(PATCH_ONLY_MUTATION_ACTIONS);
    const executionMode = input.control.project.executionMode;

    for (const step of input.plan.steps) {
      const action = step.actionType;

      if (forbidden.has(action)) {
        results.push(
          this.findings.create({
            validatorType: "SECURITY",
            category: "forbidden-action",
            severity: "CRITICAL",
            ruleId: "SECURITY_FORBIDDEN_ACTION",
            message: `Action ${action} is categorically forbidden`,
            repairable: false,
            approvalEligible: false,
            blocking: true,
            affectedStepIds: [step.stepId],
            subject: { actionType: action },
          }),
        );
      }

      if (deployments.has(action)) {
        results.push(
          this.findings.create({
            validatorType: "SECURITY",
            category: "deployment",
            severity: "CRITICAL",
            ruleId: "SECURITY_DEPLOYMENT_NOT_PERMITTED",
            message: `Deployment action ${action} is not permitted from an orchestrated plan`,
            repairable: false,
            approvalEligible: false,
            blocking: true,
            affectedStepIds: [step.stepId],
            subject: { actionType: action, environment: input.environment },
          }),
        );
      }

      if (
        executionMode === "PATCH_ONLY" &&
        !patchOnlyAllowed.has(action) &&
        this.looksMutating(step.actionType, step.risk.categories)
      ) {
        results.push(
          this.findings.create({
            validatorType: "SECURITY",
            category: "execution-mode",
            severity: "CRITICAL",
            ruleId: "SECURITY_EXECUTION_MODE_VIOLATION",
            message: `Mutating action ${action} exceeds PATCH_ONLY execution mode`,
            repairable: false,
            approvalEligible: false,
            blocking: true,
            affectedStepIds: [step.stepId],
            subject: { actionType: action, executionMode },
          }),
        );
      }

      const surface = [
        step.description,
        ...step.targetIds,
        ...step.preconditions,
        ...step.expectedPostconditions,
      ]
        .join(" ")
        .toLowerCase();
      const secretHit = SECRET_HINTS.find((hint) => surface.includes(hint));
      if (secretHit !== undefined) {
        results.push(
          this.findings.create({
            validatorType: "SECURITY",
            category: "secret-material",
            severity: "ERROR",
            ruleId: "SECURITY_SECRET_MATERIAL_REFERENCE",
            message: `Step references secret material (${secretHit})`,
            repairable: true,
            approvalEligible: false,
            blocking: true,
            affectedStepIds: [step.stepId],
            subject: { hint: secretHit },
          }),
        );
      }

      if (
        step.risk.level === "CRITICAL" &&
        step.rollback.strategy === "NONE"
      ) {
        results.push(
          this.findings.create({
            validatorType: "SECURITY",
            category: "containment",
            severity: "ERROR",
            ruleId: "SECURITY_CRITICAL_STEP_WITHOUT_ROLLBACK",
            message: "CRITICAL-risk step declares no rollback strategy",
            repairable: true,
            approvalEligible: false,
            blocking: true,
            affectedStepIds: [step.stepId],
            subject: { actionType: action, riskLevel: step.risk.level },
          }),
        );
      }

      if (
        step.risk.level === "HIGH" &&
        step.validation.checks.length === 0
      ) {
        results.push(
          this.findings.create({
            validatorType: "SECURITY",
            category: "containment",
            severity: "WARNING",
            ruleId: "SECURITY_HIGH_RISK_STEP_UNVERIFIED",
            message: "HIGH-risk step declares no validation checks",
            repairable: true,
            approvalEligible: true,
            blocking: false,
            affectedStepIds: [step.stepId],
            subject: { actionType: action, riskLevel: step.risk.level },
          }),
        );
      }
    }

    if (
      input.plan.failurePolicy.onStepFailure === "FAIL_RUN" &&
      input.plan.steps.some((step) => step.risk.level === "CRITICAL")
    ) {
      results.push(
        this.findings.create({
          validatorType: "SECURITY",
          category: "containment",
          severity: "WARNING",
          ruleId: "SECURITY_CRITICAL_RISK_WITHOUT_CONTAINMENT",
          message:
            "Plan contains CRITICAL-risk steps but does not contain or escalate on failure",
          repairable: true,
          approvalEligible: true,
          blocking: false,
          subject: { onStepFailure: input.plan.failurePolicy.onStepFailure },
        }),
      );
    }

    return results;
  }

  private looksMutating(
    actionType: string,
    riskCategories: readonly string[],
  ): boolean {
    const haystack = `${actionType} ${riskCategories.join(" ")}`.toUpperCase();
    return [
      "WRITE",
      "DELETE",
      "PUSH",
      "MERGE",
      "DEPLOY",
      "MUTAT",
      "PUBLISH",
      "GRANT",
      "REVOKE",
    ].some((token) => haystack.includes(token));
  }
}
