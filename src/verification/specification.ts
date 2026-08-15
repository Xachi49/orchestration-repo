import type { Objective } from "../domain/objective/objective.js";
import {
  AcceptanceCriterionIdentityService,
  normalizeCriterionText,
} from "../domain/objective/criterion-identity.js";
import { objectiveFingerprint } from "../domain/objective/fingerprint.js";
import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import {
  planPostconditionId,
  planVerificationRequirementId,
} from "../domain/plan/verification-binding.js";
import {
  parseVerificationSpecification,
  type VerificationSpecification,
} from "../domain/verification/index.js";
import {
  canonicalizeValue,
  sha256Text,
} from "../ingestion/hashing.js";
import type { VerificationIdentityGenerator } from "./identity.js";

/**
 * Compile VerificationSpecification from immutable objective + plan.
 * Criterion IDs come from shared AcceptanceCriterionIdentityService (Phase 4–8).
 * Does not invent acceptance criteria.
 */
export class VerificationSpecificationCompiler {
  constructor(private readonly identities: VerificationIdentityGenerator) {}

  compile(input: {
    runId: string;
    objective: Objective;
    plan: ExecutionPlan;
  }): VerificationSpecification {
    const criterionIdentities =
      new AcceptanceCriterionIdentityService().deriveFromObjective(
        input.objective,
      );

    const objFp = objectiveFingerprint({
      requestedOutcome: input.objective.requestedOutcome,
      acceptanceCriteria: input.objective.acceptanceCriteria,
      nonGoals: input.objective.nonGoals,
      constraints: input.objective.constraints,
      priority: input.objective.priority,
      ...(input.objective.deadline !== undefined
        ? { deadline: input.objective.deadline }
        : {}),
    });

    const acceptanceCriteria = criterionIdentities.map((id) => ({
      criterionId: id.criterionId,
      criterionText: id.criterionText,
      index: id.index,
      required: true,
    }));

    const postconditions = input.plan.steps.flatMap((step) =>
      step.expectedPostconditions.map((expected, index) => ({
        postconditionId: planPostconditionId(step.stepId, index, expected),
        stepId: step.stepId,
        expected,
        index,
      })),
    );

    const verificationRequirements = input.plan.steps.flatMap((step) =>
      step.validation.checks.map((check, index) => ({
        requirementId: planVerificationRequirementId(step.stepId, index),
        stepId: step.stepId,
        check,
      })),
    );

    const hashPayload = {
      acceptanceCriteria: acceptanceCriteria.map((c) => ({
        criterionId: c.criterionId,
        criterionText: c.criterionText,
        index: c.index,
      })),
      constraints: [...input.objective.constraints],
      nonGoals: [...input.objective.nonGoals],
      postconditions: postconditions.map((p) => ({
        postconditionId: p.postconditionId,
        stepId: p.stepId,
        expected: p.expected,
      })),
      verificationRequirements: verificationRequirements.map((r) => ({
        requirementId: r.requirementId,
        stepId: r.stepId,
        check: r.check,
      })),
      bindings: input.plan.acceptanceCriterionVerificationBindings,
      planId: input.plan.planId,
      planVersion: input.plan.planVersion,
      planHash: input.plan.planHash,
      objectiveFingerprint: objFp,
    };

    return parseVerificationSpecification({
      specificationId: this.identities.nextSpecificationId(),
      runId: input.runId,
      objectiveId: input.objective.objectiveId,
      objectiveVersion: input.objective.objectiveVersion,
      objectiveFingerprint: objFp,
      planId: input.plan.planId,
      planVersion: input.plan.planVersion,
      planHash: input.plan.planHash,
      acceptanceCriteria,
      constraints: [...input.objective.constraints],
      nonGoals: [...input.objective.nonGoals],
      postconditions,
      verificationRequirements,
      verificationSpecificationHash: sha256Text(
        JSON.stringify(canonicalizeValue(hashPayload)),
      ),
    });
  }
}

export { normalizeCriterionText };

export function hashVerificationSpecification(
  spec: VerificationSpecification,
): string {
  return spec.verificationSpecificationHash;
}
