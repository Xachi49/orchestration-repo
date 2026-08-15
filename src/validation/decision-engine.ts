import type {
  ValidationDecisionClass,
  ValidationFinding,
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
 * PASS is not approval. The run remains in VALIDATING; Phase 6 owns approval.
 */
export class ValidationDecisionEngine {
  decide(input: ValidationDecisionInput): ValidationDecisionOutcome {
    const hardBlocking = input.findings.filter(
      (finding) =>
        finding.blocking && !finding.repairable && !finding.approvalEligible,
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
      return {
        decision: "HUMAN_APPROVAL_REQUIRED",
        reasonCodes: ["APPROVAL_REQUIRED_NON_REPAIRABLE"],
        requiresHumanAction: true,
        decidingFindingIds: approvableBlocking.map(
          (finding) => finding.findingId,
        ),
      };
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
        return {
          decision: "HUMAN_APPROVAL_REQUIRED",
          reasonCodes: ["REPEATED_SEMANTIC_VIOLATION"],
          requiresHumanAction: true,
          decidingFindingIds: recurring.map((finding) => finding.findingId),
        };
      }
      if (input.remainingRevisionAttempts <= 0) {
        return {
          decision: "HUMAN_APPROVAL_REQUIRED",
          reasonCodes: ["REVISION_ATTEMPTS_EXHAUSTED"],
          requiresHumanAction: true,
          decidingFindingIds: repairableBlocking.map(
            (finding) => finding.findingId,
          ),
        };
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
