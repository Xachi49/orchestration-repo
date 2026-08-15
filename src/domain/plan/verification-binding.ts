import { z } from "zod";
import { createHash } from "node:crypto";
import { normalizeCriterionText } from "../objective/criterion-identity.js";

/**
 * Bounded verification methods that may authorize criterion satisfaction.
 * FREEFORM_MODEL_ASSESSMENT / ARBITRARY_COMMAND / ARBITRARY_URL are forbidden.
 */
export const VerificationBindingMethodSchema = z.enum([
  "STEP_POSTCONDITION",
  "REGISTERED_TEST_RESULT",
  "EXECUTION_ARTIFACT",
  "TASK_RECORD",
  "PR_PREPARATION_ARTIFACT",
  "ACTION_OUTCOME",
]);

export type VerificationBindingMethod = z.infer<
  typeof VerificationBindingMethodSchema
>;

export const RequiredEvidenceClassSchema = z.enum([
  "SYSTEM_OBSERVED",
  "SYSTEM_RECOMPUTED",
  "VERIFIED_EXECUTION_RECORD",
]);

export type RequiredEvidenceClass = z.infer<typeof RequiredEvidenceClassSchema>;

/**
 * Authoritative plan-bound contract: how an acceptance criterion will be proven.
 * Participates in planHash. HEURISTIC_RELEVANCE ≠ VERIFICATION_BINDING.
 */
export const AcceptanceCriterionVerificationBindingSchema = z
  .object({
    criterionId: z.string().min(1),
    criterionTextHash: z.string().min(1),
    verificationMethod: VerificationBindingMethodSchema,
    stepIds: z.array(z.string().min(1)).min(1),
    verificationRequirementIds: z.array(z.string().min(1)),
    postconditionIds: z.array(z.string().min(1)),
    requiredEvidenceClasses: z.array(RequiredEvidenceClassSchema).min(1),
    requireAll: z.boolean(),
    /** Required when method is REGISTERED_TEST_RESULT. */
    testProfileId: z.string().min(1).optional(),
    /** Required when method is EXECUTION_ARTIFACT or PR_PREPARATION_ARTIFACT. */
    artifactTypes: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type AcceptanceCriterionVerificationBinding = z.infer<
  typeof AcceptanceCriterionVerificationBindingSchema
>;

export function parseAcceptanceCriterionVerificationBinding(
  input: unknown,
): AcceptanceCriterionVerificationBinding {
  return AcceptanceCriterionVerificationBindingSchema.parse(input);
}

/** Stable postcondition id used in plans and Phase 8 specifications. */
export function planPostconditionId(
  stepId: string,
  index: number,
  expected: string,
): string {
  const digest = createHash("sha256")
    .update(normalizeCriterionText(expected), "utf8")
    .digest("hex")
    .slice(0, 12);
  return `pc_${stepId}_${index}_${digest}`;
}

/** Stable verification-requirement id for a step validation check. */
export function planVerificationRequirementId(
  stepId: string,
  index: number,
): string {
  return `req_${stepId}_${index}`;
}

/** Methods compatible with a Phase 7 (or broader) action type. */
export function methodsCompatibleWithAction(
  actionType: string,
): readonly VerificationBindingMethod[] {
  switch (actionType) {
    case "CREATE_LOCAL_PATCH":
      return ["STEP_POSTCONDITION", "EXECUTION_ARTIFACT", "ACTION_OUTCOME"];
    case "RUN_TESTS":
      return [
        "STEP_POSTCONDITION",
        "REGISTERED_TEST_RESULT",
        "ACTION_OUTCOME",
      ];
    case "CREATE_TASK":
      return ["STEP_POSTCONDITION", "TASK_RECORD", "ACTION_OUTCOME"];
    case "PREPARE_PULL_REQUEST":
      return [
        "STEP_POSTCONDITION",
        "PR_PREPARATION_ARTIFACT",
        "ACTION_OUTCOME",
      ];
    default:
      return ["STEP_POSTCONDITION", "ACTION_OUTCOME"];
  }
}

export function isMethodCompatibleWithAction(
  method: VerificationBindingMethod,
  actionType: string,
): boolean {
  return methodsCompatibleWithAction(actionType).includes(method);
}
