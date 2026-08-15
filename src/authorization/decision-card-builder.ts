import type { Objective } from "../domain/objective/objective.js";
import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import type { ValidationDecision } from "../domain/validation/index.js";
import {
  parseApprovalDecisionCard,
  type ApprovalDecisionCard,
} from "../domain/authorization/index.js";
import type { PlanningException } from "../validation/exception.js";

export function buildApprovalDecisionCard(input: {
  objective: Objective;
  plan: ExecutionPlan;
  decision: ValidationDecision;
  whyApprovalRequired: string;
  createdAt: string;
  expiresAt: string;
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
    ...new Set(
      input.plan.steps.flatMap((step) => step.validation.checks),
    ),
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
