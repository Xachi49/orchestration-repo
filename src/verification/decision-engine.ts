import type {
  AcceptanceCriterionResult,
  OutcomeVerdict,
  StepPostconditionResult,
  VerificationFinding,
} from "../domain/verification/index.js";
import type { ContextualOutcomeAssessment } from "./model.js";

export interface OutcomeDecisionInput {
  contained: boolean;
  unresolvedSideEffectUncertainty: boolean;
  criterionResults: readonly AcceptanceCriterionResult[];
  postconditionResults: readonly StepPostconditionResult[];
  findings: readonly VerificationFinding[];
  coverageComplete: boolean;
  artifactIntegrityOk: boolean;
  historicalAuthorityOk: boolean;
  boundaryOk: boolean;
  governanceOk: boolean;
  /** Every immutable criterion has an approved plan binding. */
  allCriteriaHaveApprovedBindings: boolean;
  /** Every binding fulfilled by qualifying authoritative evidence. */
  allBindingsFulfilled: boolean;
  contextual?: ContextualOutcomeAssessment | undefined;
}

export interface OutcomeDecision {
  outcome: OutcomeVerdict;
  requiresHumanReview: boolean;
  reasonCodes: readonly string[];
}

/**
 * Authoritative outcome precedence (milestone 32).
 * Model recommendation never creates VERIFIED_SUCCESS.
 */
export class OutcomeDecisionEngine {
  decide(input: OutcomeDecisionInput): OutcomeDecision {
    if (input.contained || input.unresolvedSideEffectUncertainty) {
      return {
        outcome: "CONTAINED",
        requiresHumanReview: true,
        reasonCodes: ["CONTAINED_OR_UNRESOLVED"],
      };
    }

    const hardFailures = input.findings.filter(
      (f) =>
        f.blocksVerifiedSuccess &&
        (f.category === "BINDING" ||
          f.category === "ARTIFACT_INTEGRITY" ||
          f.category === "BOUNDARY" ||
          f.category === "GOVERNANCE" ||
          f.category === "AUTHORITY" ||
          f.category === "RESOURCE" ||
          f.ruleId === "VERIFICATION_SCOPE_VIOLATION" ||
          f.ruleId === "VERIFICATION_GOVERNANCE_VIOLATION" ||
          f.ruleId === "VERIFICATION_ARTIFACT_HASH_MISMATCH" ||
          f.ruleId === "VERIFICATION_ARTIFACT_MISSING" ||
          f.ruleId === "VERIFICATION_ARTIFACT_IDENTITY_MISMATCH" ||
          f.ruleId === "VERIFICATION_AUTHORITY_MISMATCH" ||
          f.ruleId === "VERIFICATION_BINDING_MISMATCH"),
    );

    if (
      hardFailures.length > 0 ||
      !input.artifactIntegrityOk ||
      !input.historicalAuthorityOk ||
      !input.boundaryOk ||
      !input.governanceOk
    ) {
      return {
        outcome: "VERIFICATION_FAILED",
        requiresHumanReview: true,
        reasonCodes: ["HARD_INTEGRITY_OR_GOVERNANCE_FAILURE"],
      };
    }

    const required = input.criterionResults.filter((c) => true);
    const unsatisfied = required.filter((c) => c.verdict === "UNSATISFIED");
    const satisfied = required.filter((c) => c.verdict === "SATISFIED");
    const partial = required.filter(
      (c) => c.verdict === "PARTIALLY_SATISFIED",
    );
    const inconclusive = required.filter((c) => c.verdict === "INCONCLUSIVE");

    if (unsatisfied.length > 0) {
      if (satisfied.length > 0) {
        return {
          outcome: "PARTIAL_SUCCESS",
          requiresHumanReview: true,
          reasonCodes: ["SOME_CRITERIA_UNSATISFIED"],
        };
      }
      return {
        outcome: "VERIFICATION_FAILED",
        requiresHumanReview: true,
        reasonCodes: ["REQUIRED_CRITERIA_UNSATISFIED"],
      };
    }

    if (partial.length > 0) {
      return {
        outcome: "PARTIAL_SUCCESS",
        requiresHumanReview: true,
        reasonCodes: ["CRITERION_PARTIALLY_SATISFIED"],
      };
    }

    if (inconclusive.length > 0 || !input.coverageComplete) {
      return {
        outcome: "INCONCLUSIVE",
        requiresHumanReview: true,
        reasonCodes: ["MISSING_OR_INCONCLUSIVE_EVIDENCE"],
      };
    }

    const postUnsatisfied = input.postconditionResults.filter(
      (p) => p.verdict === "UNSATISFIED",
    );
    const postPartial = input.postconditionResults.filter(
      (p) => p.verdict === "PARTIALLY_SATISFIED",
    );
    const postInconclusive = input.postconditionResults.filter(
      (p) => p.verdict === "INCONCLUSIVE",
    );

    if (postUnsatisfied.length > 0) {
      return {
        outcome:
          satisfied.length > 0 ? "PARTIAL_SUCCESS" : "VERIFICATION_FAILED",
        requiresHumanReview: true,
        reasonCodes: ["POSTCONDITION_UNSATISFIED"],
      };
    }
    if (postPartial.length > 0) {
      return {
        outcome: "PARTIAL_SUCCESS",
        requiresHumanReview: true,
        reasonCodes: ["POSTCONDITION_PARTIAL"],
      };
    }
    if (postInconclusive.length > 0) {
      return {
        outcome: "INCONCLUSIVE",
        requiresHumanReview: true,
        reasonCodes: ["POSTCONDITION_INCONCLUSIVE"],
      };
    }

    // Contextual downgrade only — never upgrade to VERIFIED_SUCCESS
    let outcome: OutcomeVerdict = "VERIFIED_SUCCESS";
    const reasonCodes: string[] = ["ALL_CRITERIA_SATISFIED"];

    if (
      !input.allCriteriaHaveApprovedBindings ||
      !input.allBindingsFulfilled
    ) {
      return {
        outcome: "INCONCLUSIVE",
        requiresHumanReview: true,
        reasonCodes: ["APPROVED_BINDING_INCOMPLETE"],
      };
    }

    if (input.contextual) {
      const blockingContextual = input.contextual.findings.filter(
        (f) => f.blocksVerifiedSuccess,
      );
      const materialGaps =
        input.contextual.missingEvidence.length > 0 ||
        input.contextual.contradictions.length > 0 ||
        input.contextual.unsupportedClaims.length > 0 ||
        blockingContextual.length > 0;

      if (materialGaps) {
        const rec = input.contextual.recommendedOutcome;
        if (rec === "VERIFICATION_FAILED") {
          outcome = "VERIFICATION_FAILED";
          reasonCodes.push("CONTEXTUAL_DOWNGRADE_FAILED");
        } else if (rec === "PARTIAL_SUCCESS") {
          outcome = "PARTIAL_SUCCESS";
          reasonCodes.push("CONTEXTUAL_DOWNGRADE_PARTIAL");
        } else {
          outcome = "INCONCLUSIVE";
          reasonCodes.push("CONTEXTUAL_DOWNGRADE_INCONCLUSIVE");
        }
      } else if (
        input.contextual.recommendedOutcome === "VERIFIED_SUCCESS"
      ) {
        // Advisory only — already at VERIFIED_SUCCESS from deterministic path
        reasonCodes.push("CONTEXTUAL_AGREES_ADVISORY");
      } else if (
        input.contextual.recommendedOutcome === "INCONCLUSIVE" ||
        input.contextual.recommendedOutcome === "PARTIAL_SUCCESS" ||
        input.contextual.recommendedOutcome === "VERIFICATION_FAILED"
      ) {
        // Structured concerns without blocksVerifiedSuccess still may downgrade
        // only when deterministic classification marks findings as blocking.
        // Without blocking findings, keep VERIFIED_SUCCESS.
        reasonCodes.push("CONTEXTUAL_NONBLOCKING_ADVISORY");
      }
    }

    // Final guard: model cannot create success if deterministic gates failed
    if (
      outcome === "VERIFIED_SUCCESS" &&
      (required.some((c) => c.verdict !== "SATISFIED") ||
        input.postconditionResults.some((p) => p.verdict !== "SATISFIED") ||
        !input.coverageComplete ||
        !input.artifactIntegrityOk ||
        !input.historicalAuthorityOk ||
        !input.boundaryOk ||
        !input.governanceOk ||
        !input.allCriteriaHaveApprovedBindings ||
        !input.allBindingsFulfilled)
    ) {
      outcome = "INCONCLUSIVE";
      reasonCodes.push("SUCCESS_GATE_FAILED");
    }

    return {
      outcome,
      requiresHumanReview: outcome !== "VERIFIED_SUCCESS",
      reasonCodes,
    };
  }
}
