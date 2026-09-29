import {
  isNonApprovalEligibleBlockingFinding,
  nonApprovalEligibleBlockingFindings,
  type ValidationDecisionClass,
  type ValidationFinding,
} from "../domain/validation/index.js";

export const VALIDATION_REASON_CODES = [
  "NO_BLOCKING_FINDINGS",
  "UNREPAIRABLE_VIOLATION",
  "APPROVAL_REQUIRED_NON_REPAIRABLE",
  "REPEATED_SEMANTIC_VIOLATION",
  "REVISION_ATTEMPTS_EXHAUSTED",
  "REPAIRABLE_VIOLATION",
  "APPROVAL_ELIGIBLE_FINDING",
  /** Emitted by ValidationService when a permitted revision could not be produced. */
  "REVISION_FAILED",
  /**
   * An escalation was refused because an unresolved blocking finding is not
   * approval-eligible. Always accompanies BLOCK.
   */
  "NON_APPROVAL_ELIGIBLE_BLOCKING_FINDING",
] as const;
export type ValidationReasonCode = (typeof VALIDATION_REASON_CODES)[number];

export interface ValidationDecisionInput {
  findings: readonly ValidationFinding[];
  /** Fingerprints seen in an earlier attempt for this run. */
  repeatedFingerprints: readonly string[];
  /** Revisions still permitted for this plan lineage. */
  remainingRevisionAttempts: number;
}

export interface ValidationDecisionOutcome {
  decision: ValidationDecisionClass;
  reasonCodes: readonly ValidationReasonCode[];
  requiresHumanAction: boolean;
  decidingFindingIds: readonly string[];
}

/**
 * The only way Phase 5 produces HUMAN_APPROVAL_REQUIRED.
 *
 * HUMAN_ESCALATION != UNLIMITED_HUMAN_OVERRIDE: when any unresolved blocking
 * finding is approvalEligible=false the escalation fails closed to BLOCK,
 * regardless of why automation stopped (repeated violation, exhausted
 * attempts, or revision failure) and regardless of any approval-eligible
 * finding added by the escalation itself.
 */
export function boundedHumanEscalation(input: {
  findings: readonly ValidationFinding[];
  reasonCode: ValidationReasonCode;
  decidingFindingIds: readonly string[];
}): ValidationDecisionOutcome {
  const nonApprovable = nonApprovalEligibleBlockingFindings(input.findings);
  if (nonApprovable.length > 0) {
    return {
      decision: "BLOCK",
      reasonCodes: [input.reasonCode, "NON_APPROVAL_ELIGIBLE_BLOCKING_FINDING"],
      requiresHumanAction: true,
      decidingFindingIds: nonApprovable.map((finding) => finding.findingId),
    };
  }
  return {
    decision: "HUMAN_APPROVAL_REQUIRED",
    reasonCodes: [input.reasonCode],
    requiresHumanAction: true,
    decidingFindingIds: [...input.decidingFindingIds],
  };
}

/**
 * Deterministic decision precedence.
 *
 * 1. Unrepairable, non-approvable blocking violation → BLOCK.
 *    Hard policy DENY, hash/staleness failure, and hard budget exceed land here
 *    and are never routed to a revision or an approver.
 * 2. Unrepairable blocking violation that is explicitly approval-eligible
 *    → HUMAN_APPROVAL_REQUIRED.
 * 3. Repairable blocking violation:
 *    a. already seen in an earlier attempt → HUMAN_APPROVAL_REQUIRED
 *       (the revision loop is not converging)
 *    b. no revision attempts left → HUMAN_APPROVAL_REQUIRED
 *    c. otherwise → REVISE
 * 4. Approval-eligible non-blocking finding → HUMAN_APPROVAL_REQUIRED.
 * 5. Otherwise → PASS.
 *
 * Every HUMAN_APPROVAL_REQUIRED above passes through boundedHumanEscalation:
 * an unresolved blocking approvalEligible=false finding turns it into BLOCK.
 *
 * PASS is not approval. The run remains in VALIDATING; Phase 6 owns approval.
 */
export class ValidationDecisionEngine {
  decide(input: ValidationDecisionInput): ValidationDecisionOutcome {
    const hardBlocking = input.findings.filter(
      (finding) =>
        !finding.repairable && isNonApprovalEligibleBlockingFinding(finding),
    );
    if (hardBlocking.length > 0) {
      return {
        decision: "BLOCK",
        reasonCodes: ["UNREPAIRABLE_VIOLATION"],
        requiresHumanAction: true,
        decidingFindingIds: hardBlocking.map((finding) => finding.findingId),
      };
    }

    const approvableBlocking = input.findings.filter(
      (finding) =>
        finding.blocking && !finding.repairable && finding.approvalEligible,
    );
    if (approvableBlocking.length > 0) {
      // A revision envelope cannot be built beside an unrepairable blocker, so
      // any repairable non-approvable blocker here stays unresolved.
      return boundedHumanEscalation({
        findings: input.findings,
        reasonCode: "APPROVAL_REQUIRED_NON_REPAIRABLE",
        decidingFindingIds: approvableBlocking.map(
          (finding) => finding.findingId,
        ),
      });
    }

    const repairableBlocking = input.findings.filter(
      (finding) => finding.blocking && finding.repairable,
    );
    if (repairableBlocking.length > 0) {
      const repeated = new Set(input.repeatedFingerprints);
      const recurring = repairableBlocking.filter((finding) =>
        repeated.has(finding.semanticFingerprint),
      );
      if (recurring.length > 0) {
        return boundedHumanEscalation({
          findings: input.findings,
          reasonCode: "REPEATED_SEMANTIC_VIOLATION",
          decidingFindingIds: recurring.map((finding) => finding.findingId),
        });
      }
      if (input.remainingRevisionAttempts <= 0) {
        return boundedHumanEscalation({
          findings: input.findings,
          reasonCode: "REVISION_ATTEMPTS_EXHAUSTED",
          decidingFindingIds: repairableBlocking.map(
            (finding) => finding.findingId,
          ),
        });
      }
      return {
        decision: "REVISE",
        reasonCodes: ["REPAIRABLE_VIOLATION"],
        requiresHumanAction: false,
        decidingFindingIds: repairableBlocking.map(
          (finding) => finding.findingId,
        ),
      };
    }

    const approvalEligible = input.findings.filter(
      (finding) => !finding.blocking && finding.approvalEligible,
    );
    if (approvalEligible.length > 0) {
      return {
        decision: "HUMAN_APPROVAL_REQUIRED",
        reasonCodes: ["APPROVAL_ELIGIBLE_FINDING"],
        requiresHumanAction: true,
        decidingFindingIds: approvalEligible.map(
          (finding) => finding.findingId,
        ),
      };
    }

    return {
      decision: "PASS",
      reasonCodes: ["NO_BLOCKING_FINDINGS"],
      requiresHumanAction: false,
      decidingFindingIds: [],
    };
  }
}
