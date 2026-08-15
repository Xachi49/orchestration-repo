import type { CapabilityRegistry } from "../control-plane/capabilities/registry.js";
import type { Capability } from "../control-plane/capabilities/capability.js";
import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import type { ValidationFinding } from "../domain/validation/index.js";
import { ValidationFindingFactory } from "./finding-factory.js";

export interface PlanCapabilityValidatorInput {
  plan: ExecutionPlan;
  environment: string;
}

/**
 * Independent capability re-check.
 *
 * This does not reuse the planning-phase result and does not trust the plan's
 * own claim that an action was permitted. Every action type is re-resolved
 * against the registry, in the environment being validated, from scratch.
 */
export class IndependentCapabilityValidator {
  constructor(
    private readonly capabilities: CapabilityRegistry,
    private readonly findings: ValidationFindingFactory = new ValidationFindingFactory(),
  ) {}

  async validate(
    input: PlanCapabilityValidatorInput,
  ): Promise<ValidationFinding[]> {
    const registry = await this.capabilities.list();
    const results: ValidationFinding[] = [];

    for (const step of input.plan.steps) {
      const action = step.actionType;
      const forbiddenBy = registry.filter((capability) =>
        capability.forbiddenActions.includes(action),
      );
      const candidates = registry.filter((capability) =>
        capability.allowedActions.includes(action),
      );

      if (forbiddenBy.length > 0 && candidates.length === 0) {
        results.push(
          this.findings.create({
            validatorType: "CAPABILITY",
            category: "capability-grant",
            severity: "CRITICAL",
            ruleId: "CAPABILITY_ACTION_FORBIDDEN",
            message: `Action ${action} is explicitly forbidden by capability configuration`,
            repairable: false,
            approvalEligible: false,
            blocking: true,
            affectedStepIds: [step.stepId],
            subject: { actionType: action },
            metadata: {
              capabilityIds: forbiddenBy.map((c) => c.capabilityId),
            },
          }),
        );
        continue;
      }

      if (candidates.length === 0) {
        results.push(
          this.findings.create({
            validatorType: "CAPABILITY",
            category: "capability-grant",
            severity: "ERROR",
            ruleId: "CAPABILITY_ACTION_UNKNOWN",
            message: `Action ${action} maps to no registered capability`,
            repairable: true,
            approvalEligible: false,
            blocking: true,
            affectedStepIds: [step.stepId],
            subject: { actionType: action },
          }),
        );
        continue;
      }

      let permittedBy: Capability | null = null;
      let lastReason = "ACTION_NOT_PERMITTED";
      for (const capability of candidates) {
        const decision = await this.capabilities.isActionAllowed(
          capability.capabilityId,
          action,
          input.environment,
        );
        if (decision.allowed) {
          permittedBy = capability;
          break;
        }
        lastReason = decision.reason;
      }

      if (!permittedBy) {
        results.push(
          this.findings.create({
            validatorType: "CAPABILITY",
            category: "capability-grant",
            severity: "CRITICAL",
            ruleId: "CAPABILITY_NOT_PERMITTED",
            message: `Action ${action} is not permitted in ${input.environment} (${lastReason})`,
            repairable: false,
            approvalEligible: false,
            blocking: true,
            affectedStepIds: [step.stepId],
            subject: {
              actionType: action,
              environment: input.environment,
              reason: lastReason,
            },
          }),
        );
        continue;
      }

      if (permittedBy.approvalRequirement === "REQUIRED") {
        results.push(
          this.findings.create({
            validatorType: "CAPABILITY",
            category: "capability-approval",
            severity: "WARNING",
            ruleId: "CAPABILITY_APPROVAL_REQUIRED",
            message: `Capability ${permittedBy.capabilityId} requires human approval`,
            repairable: false,
            approvalEligible: true,
            blocking: false,
            affectedStepIds: [step.stepId],
            subject: {
              actionType: action,
              capabilityId: permittedBy.capabilityId,
            },
          }),
        );
      }
    }

    return results;
  }
}
