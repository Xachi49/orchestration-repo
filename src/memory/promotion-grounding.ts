import type { ClaimGroundingVerdict } from "../domain/memory/claim.js";

/**
 * HUMAN REVIEW != FACTUAL EVIDENCE
 *
 * A reviewer may govern whether a supported historical lesson should
 * influence future planning. A reviewer may not transform an unsupported
 * factual claim into precedent.
 *
 * UNGROUNDED → NEVER PROMOTABLE
 */
export function isAutoPromotableGrounding(
  verdict: ClaimGroundingVerdict,
): boolean {
  return verdict === "DETERMINISTICALLY_GROUNDED";
}

export function isHumanPromotableGrounding(
  verdict: ClaimGroundingVerdict,
): boolean {
  return (
    verdict === "DETERMINISTICALLY_GROUNDED" ||
    verdict === "REQUIRES_HUMAN_REVIEW"
  );
}

export function isNeverPromotableGrounding(
  verdict: ClaimGroundingVerdict,
): boolean {
  return verdict === "UNGROUNDED";
}

/**
 * PARTIALLY_GROUNDED cannot be proven to become grounded by scope narrowing
 * in this architecture. Fail closed: review may REJECT or REQUEST_NARROWER_SCOPE,
 * but must not PROMOTE.
 */
export function isHumanPromoteBlockedByPartialGrounding(
  verdict: ClaimGroundingVerdict,
): boolean {
  return verdict === "PARTIALLY_GROUNDED";
}

export function isCorroborationEligibleGrounding(
  verdict: ClaimGroundingVerdict,
): boolean {
  return verdict !== "UNGROUNDED";
}
