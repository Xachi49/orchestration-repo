import {
  nonApprovalEligibleBlockingFindings,
  type ValidationDecision,
} from "../domain/validation/index.js";
import { AuthorizationError } from "./errors.js";

const MAX_REPORTED_RULE_IDS = 20;

/**
 * Phase 6 independently enforces the Phase 5 approval-eligibility invariant
 * against the authoritative persisted ValidationDecision.
 *
 * BLOCKING + APPROVAL_ELIGIBLE_FALSE != APPROVABLE, whatever decision class
 * was recorded and whatever the DecisionCard displays.
 */
export function assertValidationApprovalEligible(
  decision: ValidationDecision,
): void {
  if (
    decision.decision !== "PASS" &&
    decision.decision !== "HUMAN_APPROVAL_REQUIRED"
  ) {
    throw new AuthorizationError(
      "VALIDATION_NOT_APPROVAL_ELIGIBLE",
      `Validation decision ${decision.decision} cannot be approved`,
      {
        validationDecisionId: decision.validationDecisionId,
        validationDecision: decision.decision,
      },
    );
  }
  const blockers = nonApprovalEligibleBlockingFindings(decision.findings);
  if (blockers.length > 0) {
    throw new AuthorizationError(
      "VALIDATION_NOT_APPROVAL_ELIGIBLE",
      "Validation decision has unresolved blocking findings that are not approval-eligible",
      {
        validationDecisionId: decision.validationDecisionId,
        validationDecision: decision.decision,
        ruleIds: [...new Set(blockers.map((finding) => finding.ruleId))]
          .sort()
          .slice(0, MAX_REPORTED_RULE_IDS),
      },
    );
  }
}
