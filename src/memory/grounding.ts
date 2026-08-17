import type { HistoricalRunRecord } from "../domain/memory/historical-run.js";
import type {
  ClaimGroundingResult,
  LearningClaim,
} from "../domain/memory/claim.js";
import type { OutcomeVerificationRecord } from "../domain/verification/record.js";

export interface ClaimGroundingInput {
  claim: LearningClaim;
  historicalRun: HistoricalRunRecord | null;
  verification?: OutcomeVerificationRecord | null | undefined;
  resourceLedger?:
    | Readonly<Record<string, string | number | boolean>>
    | null
    | undefined;
}

function isSubset(
  claimed: readonly string[],
  actual: readonly string[],
): boolean {
  const known = new Set(actual);
  return claimed.every((item) => known.has(item));
}

function result(
  verdict: ClaimGroundingResult["verdict"],
  reasons: string[],
  matchedFactKeys: string[] = [],
): ClaimGroundingResult {
  return { verdict, reasons, matchedFactKeys };
}

/**
 * Bounded deterministic claim grounding.
 * PROVENANCE != CLAIM GROUNDING
 *
 * A historical run proves that an event occurred. It does not automatically
 * prove every lesson written about that event. This service checks whether
 * the candidate's structured claim is entailed by referenced immutable records.
 * It does not attempt natural-language theorem proving.
 */
export class LearningClaimGroundingService {
  ground(input: ClaimGroundingInput): ClaimGroundingResult {
    const { claim, historicalRun, verification, resourceLedger } = input;
    if (!historicalRun) {
      return result("UNGROUNDED", ["missing historical run"]);
    }

    if (claim.observedOutcome !== historicalRun.outcome) {
      return result("UNGROUNDED", [
        `claimed outcome ${claim.observedOutcome} != historical ${historicalRun.outcome}`,
      ]);
    }

    if (claim.planHash !== undefined && claim.planHash !== historicalRun.planHash) {
      return result("UNGROUNDED", ["claimed planHash is not the historical planHash"]);
    }

    if (!isSubset(claim.actionTypes, historicalRun.actionTypes)) {
      return result("UNGROUNDED", ["hallucinated action type not present on historical run"]);
    }

    if (!isSubset(claim.capabilityIds, historicalRun.capabilityIds)) {
      return result("UNGROUNDED", [
        "hallucinated capability id not present on historical run",
      ]);
    }

    const matched: string[] = ["observedOutcome", "actionTypes", "capabilityIds"];
    if (claim.planHash !== undefined) {
      matched.push("planHash");
    }

    switch (claim.candidateType) {
      case "SUCCESS_PATTERN":
        return this.groundSuccess(claim, historicalRun, matched);
      case "FAILURE_PATTERN":
        return this.groundFailure(claim, historicalRun, verification, matched);
      case "CONTAINMENT_PATTERN":
        return this.groundContainment(claim, historicalRun, matched);
      case "RESOURCE_PATTERN":
        return this.groundResource(claim, resourceLedger, matched);
      case "VERIFICATION_PATTERN":
        return this.groundVerification(claim, verification, matched);
      case "EVIDENCE_GAP_PATTERN":
        return this.groundEvidenceGap(claim, historicalRun, verification, matched);
      case "PROCESS_PATTERN":
        return this.groundProcess(claim, historicalRun, matched);
      case "SECURITY_PATTERN":
        return result(
          "REQUIRES_HUMAN_REVIEW",
          ["security claims require human review"],
          matched,
        );
      case "DEPENDENCY_PATTERN":
        return result(
          "PARTIALLY_GROUNDED",
          ["dependency claims are only partially entailed by historical action indexes"],
          matched,
        );
      default:
        return result("UNGROUNDED", [`unsupported candidate type ${claim.candidateType}`]);
    }
  }

  private groundSuccess(
    claim: LearningClaim,
    historicalRun: HistoricalRunRecord,
    matched: string[],
  ): ClaimGroundingResult {
    if (
      historicalRun.outcome !== "VERIFIED_SUCCESS" ||
      claim.observedOutcome !== "VERIFIED_SUCCESS"
    ) {
      return result("UNGROUNDED", ["SUCCESS_PATTERN requires VERIFIED_SUCCESS"]);
    }
    return result("DETERMINISTICALLY_GROUNDED", [], matched);
  }

  private groundFailure(
    claim: LearningClaim,
    historicalRun: HistoricalRunRecord,
    verification: OutcomeVerificationRecord | null | undefined,
    matched: string[],
  ): ClaimGroundingResult {
    const eligible = new Set([
      "PARTIAL_SUCCESS",
      "VERIFICATION_FAILED",
      "CONTAINED",
      "BLOCKED",
      "REJECTED",
      "EXPIRED",
      "ESCALATED",
    ]);
    if (!eligible.has(historicalRun.outcome)) {
      return result("UNGROUNDED", [
        `FAILURE_PATTERN is not entailed by ${historicalRun.outcome}`,
      ]);
    }

    if (claim.findingIds.length > 0) {
      const known = new Set((verification?.findings ?? []).map((f) => f.findingId));
      if (!claim.findingIds.every((id) => known.has(id))) {
        return result("UNGROUNDED", [
          "failure claim references a finding that does not exist",
        ]);
      }
      matched.push("findingIds");
    }

    if (claim.criterionIds.length > 0) {
      const known = new Set(
        (verification?.criterionResults ?? []).map((c) => c.criterionId),
      );
      if (!claim.criterionIds.every((id) => known.has(id))) {
        return result("UNGROUNDED", [
          "failure claim references a criterion that does not exist",
        ]);
      }
      matched.push("criterionIds");
    }

    return result("DETERMINISTICALLY_GROUNDED", [], matched);
  }

  private groundContainment(
    claim: LearningClaim,
    historicalRun: HistoricalRunRecord,
    matched: string[],
  ): ClaimGroundingResult {
    if (historicalRun.outcome !== "CONTAINED") {
      return result("UNGROUNDED", ["CONTAINMENT_PATTERN requires CONTAINED outcome"]);
    }
    const reason = claim.containmentReason;
    if (reason === undefined || reason.length === 0) {
      return result("UNGROUNDED", ["containment claim missing containmentReason"]);
    }
    const allowed = new Set(["CONTAINED"]);
    if (!allowed.has(reason)) {
      return result("UNGROUNDED", [
        "containment reason does not match the containment record",
      ]);
    }
    matched.push("containmentReason");
    return result("DETERMINISTICALLY_GROUNDED", [], matched);
  }

  private groundResource(
    claim: LearningClaim,
    resourceLedger:
      | Readonly<Record<string, string | number | boolean>>
      | null
      | undefined,
    matched: string[],
  ): ClaimGroundingResult {
    const observation = claim.resourceObservation;
    if (observation === undefined) {
      return result("UNGROUNDED", ["resource claim missing resourceObservation"]);
    }
    if (!resourceLedger) {
      return result("UNGROUNDED", ["resource claim has no ledger evidence"]);
    }
    for (const [key, value] of Object.entries(observation)) {
      if (resourceLedger[key] !== value) {
        return result("UNGROUNDED", [
          `resource observation ${key} does not match ledger evidence`,
        ]);
      }
    }
    matched.push("resourceObservation");
    return result("DETERMINISTICALLY_GROUNDED", [], matched);
  }

  private groundVerification(
    claim: LearningClaim,
    verification: OutcomeVerificationRecord | null | undefined,
    matched: string[],
  ): ClaimGroundingResult {
    if (!verification) {
      return result("UNGROUNDED", ["verification claim missing verification record"]);
    }

    if (claim.criterionIds.length > 0) {
      const known = new Set(verification.criterionResults.map((c) => c.criterionId));
      if (!claim.criterionIds.every((id) => known.has(id))) {
        return result("UNGROUNDED", [
          "verification claim references a criterion that does not exist",
        ]);
      }
      matched.push("criterionIds");
    }

    if (claim.verificationMethods.length > 0) {
      const known = new Set(
        verification.criterionResults
          .map((c) => c.verificationMethod)
          .filter((m): m is string => typeof m === "string" && m.length > 0),
      );
      if (!claim.verificationMethods.every((m) => known.has(m))) {
        return result("UNGROUNDED", [
          "verification claim references a method that does not exist",
        ]);
      }
      matched.push("verificationMethods");
    }

    if (
      claim.criterionIds.length === 0 &&
      claim.verificationMethods.length === 0
    ) {
      return result("PARTIALLY_GROUNDED", [
        "verification claim has no criterion or method facts to prove",
      ]);
    }

    return result("DETERMINISTICALLY_GROUNDED", [], matched);
  }

  private groundEvidenceGap(
    claim: LearningClaim,
    historicalRun: HistoricalRunRecord,
    verification: OutcomeVerificationRecord | null | undefined,
    matched: string[],
  ): ClaimGroundingResult {
    if (historicalRun.outcome !== "INCONCLUSIVE") {
      return result("UNGROUNDED", [
        "EVIDENCE_GAP_PATTERN requires INCONCLUSIVE outcome",
      ]);
    }
    if (claim.criterionIds.length > 0) {
      const known = new Set(
        (verification?.criterionResults ?? []).map((c) => c.criterionId),
      );
      if (!claim.criterionIds.every((id) => known.has(id))) {
        return result("UNGROUNDED", [
          "evidence-gap claim references a criterion that does not exist",
        ]);
      }
      matched.push("criterionIds");
    }
    return result("DETERMINISTICALLY_GROUNDED", [], matched);
  }

  private groundProcess(
    claim: LearningClaim,
    historicalRun: HistoricalRunRecord,
    matched: string[],
  ): ClaimGroundingResult {
    const terminals = new Set([
      "BLOCKED",
      "REJECTED",
      "EXPIRED",
      "ESCALATED",
      "CONTAINED",
      "VERIFIED_SUCCESS",
      "PARTIAL_SUCCESS",
      "VERIFICATION_FAILED",
    ]);
    if (!terminals.has(historicalRun.outcome)) {
      return result("UNGROUNDED", [
        `PROCESS_PATTERN is not entailed by ${historicalRun.outcome}`,
      ]);
    }
    void claim;
    return result("DETERMINISTICALLY_GROUNDED", [], matched);
  }
}
