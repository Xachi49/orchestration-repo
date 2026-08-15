import type { Objective } from "../domain/objective/objective.js";
import {
  AcceptanceCriterionIdentityService,
  criterionTextHash,
} from "../domain/objective/criterion-identity.js";
import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import {
  isMethodCompatibleWithAction,
  planPostconditionId,
  planVerificationRequirementId,
} from "../domain/plan/verification-binding.js";
import type { ValidationFinding } from "../domain/validation/index.js";
import { ValidationFindingFactory } from "./finding-factory.js";

/**
 * Deterministic validation of acceptance-criterion verification bindings.
 * Missing/invalid bindings → repairable BLOCKING findings (typically REVISE).
 * Model interpretation alone cannot waive these findings.
 */
export class PlanVerificationBindingValidator {
  constructor(
    private readonly findings: ValidationFindingFactory = new ValidationFindingFactory(),
    private readonly identities = new AcceptanceCriterionIdentityService(),
  ) {}

  validate(input: {
    plan: ExecutionPlan;
    objective: Objective;
  }): ValidationFinding[] {
    const findings: ValidationFinding[] = [];
    const expected = this.identities.deriveFromObjective(input.objective);
    const bindings = input.plan.acceptanceCriterionVerificationBindings ?? [];
    const stepById = new Map(input.plan.steps.map((s) => [s.stepId, s]));
    const boundIds = new Set(bindings.map((b) => b.criterionId));

    for (const identity of expected) {
      if (!boundIds.has(identity.criterionId)) {
        findings.push(
          this.findings.create({
            validatorType: "VERIFICATION_BINDING",
            category: "acceptance-criterion-binding",
            severity: "ERROR",
            ruleId: "ACCEPTANCE_CRITERION_UNBOUND",
            message: `Acceptance criterion lacks explicit verification binding: ${identity.criterionText}`,
            repairable: true,
            approvalEligible: false,
            blocking: true,
            subject: {
              criterionId: identity.criterionId,
              index: identity.index,
            },
            affectedStepIds: [],
          }),
        );
      }
    }

    const seen = new Set<string>();
    for (const binding of bindings) {
      const identity = expected.find((e) => e.criterionId === binding.criterionId);
      if (!identity) {
        findings.push(
          this.findings.create({
            validatorType: "VERIFICATION_BINDING",
            category: "acceptance-criterion-binding",
            severity: "ERROR",
            ruleId: "ACCEPTANCE_CRITERION_BINDING_UNKNOWN",
            message: `Binding references criterion not on objective: ${binding.criterionId}`,
            repairable: true,
            approvalEligible: false,
            blocking: true,
            subject: { criterionId: binding.criterionId },
          }),
        );
        continue;
      }

      if (seen.has(binding.criterionId)) {
        findings.push(
          this.findings.create({
            validatorType: "VERIFICATION_BINDING",
            category: "acceptance-criterion-binding",
            severity: "ERROR",
            ruleId: "ACCEPTANCE_CRITERION_BINDING_DUPLICATE",
            message: `Duplicate verification binding for ${binding.criterionId}`,
            repairable: true,
            approvalEligible: false,
            blocking: true,
            subject: { criterionId: binding.criterionId },
          }),
        );
      }
      seen.add(binding.criterionId);

      if (binding.criterionTextHash !== criterionTextHash(identity.criterionText)) {
        findings.push(
          this.findings.create({
            validatorType: "VERIFICATION_BINDING",
            category: "acceptance-criterion-binding",
            severity: "CRITICAL",
            ruleId: "ACCEPTANCE_CRITERION_BINDING_TEXT_MISMATCH",
            message: `Binding text hash does not match objective criterion ${binding.criterionId}`,
            repairable: false,
            approvalEligible: false,
            blocking: true,
            subject: { criterionId: binding.criterionId },
          }),
        );
      }

      for (const stepId of binding.stepIds) {
        const step = stepById.get(stepId);
        if (!step) {
          findings.push(
            this.findings.create({
              validatorType: "VERIFICATION_BINDING",
              category: "acceptance-criterion-binding",
              severity: "ERROR",
              ruleId: "ACCEPTANCE_CRITERION_BINDING_STEP_MISSING",
              message: `Binding references nonexistent step ${stepId}`,
              repairable: true,
              approvalEligible: false,
              blocking: true,
              affectedStepIds: [stepId],
              subject: { criterionId: binding.criterionId, stepId },
            }),
          );
          continue;
        }
        if (
          !isMethodCompatibleWithAction(
            binding.verificationMethod,
            step.actionType,
          )
        ) {
          findings.push(
            this.findings.create({
              validatorType: "VERIFICATION_BINDING",
              category: "acceptance-criterion-binding",
              severity: "ERROR",
              ruleId: "ACCEPTANCE_CRITERION_BINDING_METHOD_INCOMPATIBLE",
              message: `Method ${binding.verificationMethod} incompatible with ${step.actionType}`,
              repairable: true,
              approvalEligible: false,
              blocking: true,
              affectedStepIds: [stepId],
              subject: {
                criterionId: binding.criterionId,
                method: binding.verificationMethod,
                actionType: step.actionType,
              },
            }),
          );
        }
      }

      for (const pcId of binding.postconditionIds) {
        const exists = input.plan.steps.some((step) =>
          step.expectedPostconditions.some((expected, index) =>
            planPostconditionId(step.stepId, index, expected) === pcId,
          ),
        );
        if (!exists) {
          findings.push(
            this.findings.create({
              validatorType: "VERIFICATION_BINDING",
              category: "acceptance-criterion-binding",
              severity: "ERROR",
              ruleId: "ACCEPTANCE_CRITERION_BINDING_POSTCONDITION_MISSING",
              message: `Binding references nonexistent postcondition ${pcId}`,
              repairable: true,
              approvalEligible: false,
              blocking: true,
              subject: { criterionId: binding.criterionId, postconditionId: pcId },
            }),
          );
        }
      }

      for (const reqId of binding.verificationRequirementIds) {
        const exists = input.plan.steps.some((step) =>
          step.validation.checks.some(
            (_check, index) =>
              planVerificationRequirementId(step.stepId, index) === reqId,
          ),
        );
        if (!exists) {
          findings.push(
            this.findings.create({
              validatorType: "VERIFICATION_BINDING",
              category: "acceptance-criterion-binding",
              severity: "ERROR",
              ruleId: "ACCEPTANCE_CRITERION_BINDING_REQUIREMENT_MISSING",
              message: `Binding references nonexistent verification requirement ${reqId}`,
              repairable: true,
              approvalEligible: false,
              blocking: true,
              subject: {
                criterionId: binding.criterionId,
                requirementId: reqId,
              },
            }),
          );
        }
      }

      if (binding.requiredEvidenceClasses.includes("MODEL_INTERPRETATION" as never)) {
        findings.push(
          this.findings.create({
            validatorType: "VERIFICATION_BINDING",
            category: "acceptance-criterion-binding",
            severity: "CRITICAL",
            ruleId: "ACCEPTANCE_CRITERION_BINDING_MODEL_ONLY",
            message: "Binding must not rely solely on model interpretation",
            repairable: false,
            approvalEligible: false,
            blocking: true,
            subject: { criterionId: binding.criterionId },
          }),
        );
      }
    }

    return findings;
  }
}
