import type { Objective } from "../domain/objective/objective.js";
import {
  AcceptanceCriterionIdentityService,
  criterionTextHash,
} from "../domain/objective/criterion-identity.js";
import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import type { AcceptanceCriterionVerificationBinding } from "../domain/plan/verification-binding.js";
import type { ValidationDecision } from "../domain/validation/index.js";
import {
  parseApprovalDecisionCard,
  type ApprovalDecisionCard,
} from "../domain/authorization/index.js";
import type { PlanningException } from "../validation/exception.js";
import {
  capabilitySetFingerprint,
  uniqueCapabilitiesForPlanActions,
  type CapabilityAuthorityFields,
} from "../execution/capability-fingerprint.js";

export function buildApprovalDecisionCard(input: {
  objective: Objective;
  plan: ExecutionPlan;
  decision: ValidationDecision;
  whyApprovalRequired: string;
  createdAt: string;
  expiresAt: string;
  /** Authoritative Control Plane capabilities for the requested environment. */
  availableCapabilities: readonly CapabilityAuthorityFields[];
  planningException?: PlanningException;
}): ApprovalDecisionCard {
  const actionTypes = [
    ...new Set(input.plan.steps.map((step) => step.actionType)),
  ].sort();
  const riskLevels = [
    ...new Set(input.plan.steps.map((step) => step.risk.level)),
  ].sort();
  const targetsAffected = [
    ...new Set(input.plan.steps.flatMap((step) => step.targetIds)),
  ].sort();
  const verificationStrategy = [
    ...new Set(input.plan.steps.flatMap((step) => step.validation.checks)),
  ];
  const rollbackContainmentStrategy = input.plan.steps.map((step) => {
    const instructions = step.rollback.instructions?.join("; ") ?? "";
    return `${step.stepId}: ${step.rollback.strategy}${
      instructions ? ` — ${instructions}` : ""
    }`;
  });

  const approvalEligibleFindingSummaries = input.decision.findings
    .filter((finding) => finding.approvalEligible)
    .map(
      (finding) =>
        `[${finding.severity}] ${finding.ruleId}: ${finding.message}`,
    );

  const uniqueCaps = uniqueCapabilitiesForPlanActions({
    stepActionTypes: input.plan.steps.map((s) => s.actionType),
    availableCapabilities: input.availableCapabilities,
  });
  if (uniqueCaps.length === 0) {
    throw new Error(
      "Cannot build approval decision card: no capabilities permit plan actions",
    );
  }
  for (const step of input.plan.steps) {
    const permitted = input.availableCapabilities.some((c) =>
      c.allowedActions.includes(step.actionType),
    );
    if (!permitted) {
      throw new Error(
        `Cannot build approval decision card: no capability permits ${step.actionType}`,
      );
    }
  }

  const fingerprint = capabilitySetFingerprint(uniqueCaps);
  const capabilityAuthorityScope = uniqueCaps
    .map((cap) => ({
      capabilityId: cap.capabilityId,
      allowedActions: [...cap.allowedActions].sort(),
      maximumRuntimeSeconds: cap.maximumRuntimeSeconds,
      enabled: cap.enabled,
      allowedEnvironments: [...cap.allowedEnvironments].sort(),
    }))
    .sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));

  const identities = new AcceptanceCriterionIdentityService().deriveFromObjective(
    input.objective,
  );
  const textById = new Map(
    identities.map((id) => [id.criterionId, id.criterionText]),
  );

  const verificationCoverageSummary =
    input.plan.acceptanceCriterionVerificationBindings.map((binding) => {
      const criterionText =
        textById.get(binding.criterionId) ??
        input.objective.acceptanceCriteria.find(
          (text) => criterionTextHash(text) === binding.criterionTextHash,
        ) ??
        binding.criterionId;
      return {
        criterionId: binding.criterionId,
        criterionText,
        verificationMethod: binding.verificationMethod,
        howVerified: describeHowVerified(binding.verificationMethod),
        stepIds: [...binding.stepIds],
        evidenceExpectation: describeEvidenceExpectation(binding),
      };
    });

  const card: ApprovalDecisionCard = {
    objectiveId: input.objective.objectiveId,
    objectiveVersion: input.objective.objectiveVersion,
    objectiveOutcome: input.objective.requestedOutcome,
    acceptanceCriteria: [...input.objective.acceptanceCriteria],
    planId: input.plan.planId,
    planVersion: input.plan.planVersion,
    planHash: input.plan.planHash,
    validationDecisionId: input.decision.validationDecisionId,
    validationDecision: input.decision.decision as
      | "PASS"
      | "BLOCK"
      | "HUMAN_APPROVAL_REQUIRED",
    whyApprovalRequired: input.whyApprovalRequired,
    proposedActions: input.plan.steps.map((step) => ({
      stepId: step.stepId,
      actionType: step.actionType,
      description: step.description,
      targetIds: [...step.targetIds],
    })),
    targetsAffected,
    repositoryCommitSha: input.plan.repositoryCommitSha,
    repositoryFingerprint: input.plan.repositoryFingerprint,
    policyBundleId: input.plan.policyBundleId,
    policyBundleHash: input.plan.policyBundleHash,
    blastRadius: {
      stepCount: input.plan.steps.length,
      actionTypes,
      riskLevels,
    },
    estimatedResourceUsage: { ...input.plan.resourceTotals },
    verificationStrategy,
    rollbackContainmentStrategy,
    unresolvedAssumptions: [
      ...input.plan.assumptions,
      ...input.plan.unknowns,
    ],
    approvalEligibleFindingSummaries,
    capabilitySetFingerprint: fingerprint,
    capabilityAuthorityScope,
    verificationCoverageSummary,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };

  if (input.planningException) {
    card.planningExceptionSummary = {
      exceptionId: input.planningException.exceptionId,
      exceptionType: input.planningException.exceptionType,
      message: input.planningException.message,
      reasonCodes: [...input.planningException.reasonCodes],
    };
  }

  return parseApprovalDecisionCard(card);
}

function describeHowVerified(method: string): string {
  switch (method) {
    case "STEP_POSTCONDITION":
      return "Deterministic postcondition evidence on bound steps";
    case "REGISTERED_TEST_RESULT":
      return "Registered trusted test profile result";
    case "EXECUTION_ARTIFACT":
      return "Execution artifact integrity (recomputed hash/type)";
    case "TASK_RECORD":
      return "Internal task record identity";
    case "PR_PREPARATION_ARTIFACT":
      return "Pull-request preparation artifact (not a live GitHub PR)";
    case "ACTION_OUTCOME":
      return "Bounded action-outcome verifier for the bound step";
    default:
      return method;
  }
}

function describeEvidenceExpectation(
  binding: AcceptanceCriterionVerificationBinding,
): string {
  const parts = [
    `method=${binding.verificationMethod}`,
    `steps=${binding.stepIds.join(",")}`,
  ];
  if (binding.postconditionIds.length > 0) {
    parts.push(`postconditions=${binding.postconditionIds.join(",")}`);
  }
  if (binding.testProfileId) {
    parts.push(`testProfile=${binding.testProfileId}`);
  }
  if (binding.artifactTypes?.length) {
    parts.push(`artifactTypes=${binding.artifactTypes.join(",")}`);
  }
  parts.push(`requireAll=${binding.requireAll}`);
  return parts.join("; ");
}

export function whyApprovalRequiredForDecision(
  decision: ValidationDecision,
): string {
  if (decision.decision === "PASS") {
    return "Validation status: PASS. Reason for human review: execution authorization.";
  }
  if (decision.decision === "HUMAN_APPROVAL_REQUIRED") {
    const codes = [
      ...new Set(decision.findings.map((finding) => finding.ruleId)),
    ].slice(0, 8);
    return `Validation status: HUMAN_APPROVAL_REQUIRED. Human authorization required before any execution. Findings: ${codes.join(", ") || "see decision"}.`;
  }
  return `Validation status: ${decision.decision}.`;
}
