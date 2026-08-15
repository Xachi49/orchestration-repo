import type { Objective } from "../domain/objective/objective.js";
import {
  AcceptanceCriterionIdentityService,
  normalizeCriterionText,
} from "../domain/objective/criterion-identity.js";
import type {
  AcceptanceCriterionVerificationBinding,
  VerificationBindingMethod,
} from "../domain/plan/verification-binding.js";
import {
  isMethodCompatibleWithAction,
  planPostconditionId,
  planVerificationRequirementId,
} from "../domain/plan/verification-binding.js";
import { PlanningError } from "./errors.js";
import type {
  PlanProposal,
  ProposedAcceptanceCriterionVerificationBinding,
  ProposedStep,
} from "./proposal.js";

/** Minimal objective fields required to assign criterion identity. */
export type ObjectiveForBindings = {
  requestedOutcome: string;
  acceptanceCriteria: readonly string[];
  nonGoals: readonly string[];
  constraints: readonly string[];
  priority: string;
  deadline?: string | undefined;
};

const DEFAULT_EVIDENCE_CLASSES = [
  "SYSTEM_OBSERVED",
  "SYSTEM_RECOMPUTED",
  "VERIFIED_EXECUTION_RECORD",
] as const;

/**
 * Resolve model-proposed bindings into authoritative plan bindings.
 * Assigns canonical criterion IDs from the Objective. Fails closed.
 */
export function compileAcceptanceCriterionVerificationBindings(input: {
  objective: ObjectiveForBindings;
  proposal: PlanProposal;
  steps: readonly ProposedStep[];
}): AcceptanceCriterionVerificationBinding[] {
  const identities = new AcceptanceCriterionIdentityService().deriveFromFingerprintContent(
    {
      requestedOutcome: input.objective.requestedOutcome,
      acceptanceCriteria: input.objective.acceptanceCriteria,
      nonGoals: input.objective.nonGoals,
      constraints: input.objective.constraints,
      priority: input.objective.priority as Objective["priority"],
      ...(input.objective.deadline !== undefined
        ? { deadline: input.objective.deadline }
        : {}),
    },
  );
  const byNormalizedText = new Map(
    identities.map((id) => [normalizeCriterionText(id.criterionText), id]),
  );
  const stepById = new Map(input.steps.map((s) => [s.stepId, s]));
  const proposed = input.proposal.acceptanceCriterionVerificationBindings;

  const compiled: AcceptanceCriterionVerificationBinding[] = [];
  const seenCriterionIds = new Set<string>();

  for (const raw of proposed) {
    const identity = byNormalizedText.get(
      normalizeCriterionText(raw.criterionText),
    );
    if (!identity) {
      throw new PlanningError(
        "ACCEPTANCE_CRITERION_BINDING_INVALID",
        `Verification binding references unknown acceptance criterion: ${raw.criterionText}`,
        { criterionText: raw.criterionText },
      );
    }
    if (seenCriterionIds.has(identity.criterionId)) {
      throw new PlanningError(
        "ACCEPTANCE_CRITERION_BINDING_INVALID",
        `Duplicate verification binding for criterion ${identity.criterionId}`,
        { criterionId: identity.criterionId },
      );
    }
    seenCriterionIds.add(identity.criterionId);

    for (const stepId of raw.stepIds) {
      if (!stepById.has(stepId)) {
        throw new PlanningError(
          "ACCEPTANCE_CRITERION_BINDING_INVALID",
          `Verification binding references nonexistent step ${stepId}`,
          { criterionId: identity.criterionId, stepId },
        );
      }
    }

    for (const stepId of raw.stepIds) {
      const step = stepById.get(stepId)!;
      if (!isMethodCompatibleWithAction(raw.verificationMethod, step.actionType)) {
        throw new PlanningError(
          "ACCEPTANCE_CRITERION_BINDING_INVALID",
          `Verification method ${raw.verificationMethod} incompatible with action ${step.actionType} on ${stepId}`,
          {
            criterionId: identity.criterionId,
            stepId,
            method: raw.verificationMethod,
            actionType: step.actionType,
          },
        );
      }
    }

    const postconditionIds = resolvePostconditionIds(raw, stepById);
    const verificationRequirementIds = resolveRequirementIds(raw, stepById);

    if (
      raw.verificationMethod === "REGISTERED_TEST_RESULT" &&
      !raw.testProfileId
    ) {
      throw new PlanningError(
        "ACCEPTANCE_CRITERION_BINDING_INVALID",
        "REGISTERED_TEST_RESULT binding requires testProfileId",
        { criterionId: identity.criterionId },
      );
    }
    if (
      (raw.verificationMethod === "EXECUTION_ARTIFACT" ||
        raw.verificationMethod === "PR_PREPARATION_ARTIFACT") &&
      (!raw.artifactTypes || raw.artifactTypes.length === 0)
    ) {
      throw new PlanningError(
        "ACCEPTANCE_CRITERION_BINDING_INVALID",
        `${raw.verificationMethod} binding requires artifactTypes`,
        { criterionId: identity.criterionId },
      );
    }
    if (
      raw.verificationMethod === "STEP_POSTCONDITION" &&
      postconditionIds.length === 0
    ) {
      throw new PlanningError(
        "ACCEPTANCE_CRITERION_BINDING_INVALID",
        "STEP_POSTCONDITION binding requires postconditionTexts that exist on bound steps",
        { criterionId: identity.criterionId },
      );
    }

    compiled.push({
      criterionId: identity.criterionId,
      criterionTextHash: identity.criterionTextHash,
      verificationMethod: raw.verificationMethod,
      stepIds: [...raw.stepIds],
      verificationRequirementIds,
      postconditionIds,
      requiredEvidenceClasses: [...DEFAULT_EVIDENCE_CLASSES],
      requireAll: raw.requireAll,
      ...(raw.testProfileId !== undefined
        ? { testProfileId: raw.testProfileId }
        : {}),
      ...(raw.artifactTypes !== undefined
        ? { artifactTypes: [...raw.artifactTypes] }
        : {}),
    });
  }

  for (const identity of identities) {
    if (!seenCriterionIds.has(identity.criterionId)) {
      throw new PlanningError(
        "ACCEPTANCE_CRITERION_UNBOUND",
        `Acceptance criterion lacks explicit verification binding: ${identity.criterionText}`,
        {
          criterionId: identity.criterionId,
          criterionText: identity.criterionText,
          index: identity.index,
        },
      );
    }
  }

  // Stable order by criterion index
  compiled.sort((a, b) => {
    const ia = identities.find((i) => i.criterionId === a.criterionId)?.index ?? 0;
    const ib = identities.find((i) => i.criterionId === b.criterionId)?.index ?? 0;
    return ia - ib;
  });

  return compiled;
}

function resolvePostconditionIds(
  raw: ProposedAcceptanceCriterionVerificationBinding,
  stepById: Map<string, ProposedStep>,
): string[] {
  const texts = raw.postconditionTexts ?? [];
  const ids: string[] = [];
  for (const text of texts) {
    const norm = normalizeCriterionText(text);
    let found = false;
    for (const stepId of raw.stepIds) {
      const step = stepById.get(stepId)!;
      const index = step.expectedPostconditions.findIndex(
        (p) => normalizeCriterionText(p) === norm,
      );
      if (index >= 0) {
        ids.push(
          planPostconditionId(stepId, index, step.expectedPostconditions[index]!),
        );
        found = true;
        break;
      }
    }
    if (!found) {
      throw new PlanningError(
        "ACCEPTANCE_CRITERION_BINDING_INVALID",
        `Verification binding references nonexistent postcondition: ${text}`,
        { postconditionText: text, stepIds: raw.stepIds },
      );
    }
  }
  return ids;
}

function resolveRequirementIds(
  raw: ProposedAcceptanceCriterionVerificationBinding,
  stepById: Map<string, ProposedStep>,
): string[] {
  const texts = raw.verificationCheckTexts ?? [];
  const ids: string[] = [];
  for (const text of texts) {
    const norm = normalizeCriterionText(text);
    let found = false;
    for (const stepId of raw.stepIds) {
      const step = stepById.get(stepId)!;
      const index = step.validationChecks.findIndex(
        (c) => normalizeCriterionText(c) === norm,
      );
      if (index >= 0) {
        ids.push(planVerificationRequirementId(stepId, index));
        found = true;
        break;
      }
    }
    if (!found) {
      throw new PlanningError(
        "ACCEPTANCE_CRITERION_BINDING_INVALID",
        `Verification binding references nonexistent verification check: ${text}`,
        { verificationCheckText: text, stepIds: raw.stepIds },
      );
    }
  }
  return ids;
}

/**
 * Helper for fake/test planning models: build explicit bindings from objective
 * criteria to steps by exact postcondition match, else method-compatible action.
 * Does not invent evidence — only proposes a verification contract.
 */
export function proposeBindingsForSteps(input: {
  acceptanceCriteria: readonly string[];
  steps: readonly ProposedStep[];
}): ProposedAcceptanceCriterionVerificationBinding[] {
  const bindings: ProposedAcceptanceCriterionVerificationBinding[] = [];
  for (const criterionText of input.acceptanceCriteria) {
    const norm = normalizeCriterionText(criterionText);
    const postMatch = input.steps.find((s) =>
      s.expectedPostconditions.some(
        (p) => normalizeCriterionText(p) === norm,
      ),
    );
    if (postMatch) {
      bindings.push({
        criterionText,
        verificationMethod: "STEP_POSTCONDITION",
        stepIds: [postMatch.stepId],
        postconditionTexts: [criterionText],
        verificationCheckTexts: postMatch.validationChecks.slice(0, 1),
        requireAll: true,
      });
      continue;
    }

    const methodStep = pickMethodForCriterion(norm, input.steps);
    if (!methodStep) {
      // Leave unbound — PlanCompiler will fail with ACCEPTANCE_CRITERION_UNBOUND
      continue;
    }
    bindings.push(methodStep.binding(criterionText));
  }
  return bindings;
}

function pickMethodForCriterion(
  norm: string,
  steps: readonly ProposedStep[],
): {
  binding: (
    criterionText: string,
  ) => ProposedAcceptanceCriterionVerificationBinding;
} | null {
  const find = (action: string) =>
    steps.find((s) => s.actionType === action);

  if (norm.includes("test")) {
    const step = find("RUN_TESTS");
    if (step) {
      return {
        binding: (criterionText) => ({
          criterionText,
          verificationMethod: "REGISTERED_TEST_RESULT",
          stepIds: [step.stepId],
          postconditionTexts: step.expectedPostconditions.slice(0, 1),
          requireAll: true,
          testProfileId: step.targetIds[0] ?? "UNIT_TESTS",
        }),
      };
    }
  }
  if (norm.includes("patch") || norm.includes("diff")) {
    const step = find("CREATE_LOCAL_PATCH");
    if (step) {
      return {
        binding: (criterionText) => ({
          criterionText,
          verificationMethod: "EXECUTION_ARTIFACT",
          stepIds: [step.stepId],
          postconditionTexts: step.expectedPostconditions.slice(0, 1),
          requireAll: true,
          artifactTypes: ["PATCH"],
        }),
      };
    }
  }
  if (norm.includes("task")) {
    const step = find("CREATE_TASK");
    if (step) {
      return {
        binding: (criterionText) => ({
          criterionText,
          verificationMethod: "TASK_RECORD",
          stepIds: [step.stepId],
          postconditionTexts: step.expectedPostconditions.slice(0, 1),
          requireAll: true,
        }),
      };
    }
  }
  if (norm.includes("pull request") || norm.includes("pr preparation")) {
    const step = find("PREPARE_PULL_REQUEST");
    if (step) {
      return {
        binding: (criterionText) => ({
          criterionText,
          verificationMethod: "PR_PREPARATION_ARTIFACT",
          stepIds: [step.stepId],
          postconditionTexts: step.expectedPostconditions.slice(0, 1),
          requireAll: true,
          artifactTypes: ["PR_PREPARATION"],
        }),
      };
    }
  }

  // No supported method — omit binding; PlanCompiler fails closed with UNBOUND.
  return null;
}
