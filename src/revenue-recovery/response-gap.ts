import type { Lead } from "./lead.js";
import type { LeadEvent } from "./recovery-event.js";
import { hasQualifyingHumanResponse } from "./contact-policy.js";
import type { RecoveryConfiguration } from "./recovery-config.js";
import { hashCanonical } from "./hash.js";

export type ResponseGapDetection = {
  eligible: boolean;
  reasonCode:
    | "GAP_DETECTED"
    | "THRESHOLD_NOT_ELAPSED"
    | "QUALIFYING_RESPONSE_PRESENT"
    | "LEAD_SUPPRESSED"
    | "CONFIG_DISABLED"
    | "CONFIG_MISSING";
  gapDetectedAt?: string;
  thresholdMinutes?: number;
  elapsedMinutes?: number;
  gapIdentityKey?: string;
};

/**
 * Deterministic response-gap detector.
 * GAP DETECTED ≠ AUTHORIZATION TO CONTACT.
 */
export function detectResponseGap(input: {
  lead: Lead;
  events: readonly LeadEvent[];
  config: RecoveryConfiguration | null;
  nowIso: string;
}): ResponseGapDetection {
  if (!input.config) {
    return { eligible: false, reasonCode: "CONFIG_MISSING" };
  }
  if (!input.config.enabled) {
    return { eligible: false, reasonCode: "CONFIG_DISABLED" };
  }
  if (
    input.lead.consent?.doNotContact === true ||
    input.events.some(
      (e) => e.kind === "DO_NOT_CONTACT" || e.kind === "CONSENT_REVOKED",
    )
  ) {
    // Gap may still be observable for analytics, but not eligible for recovery outreach path.
    // Spec: gap may be observable; contact blocked separately. For case opening we still
    // allow ANALYZING cases from gap, but mark reason. Keep eligible for case creation
    // when threshold elapsed; contact policy blocks outreach.
  }

  if (hasQualifyingHumanResponse(input.events)) {
    return { eligible: false, reasonCode: "QUALIFYING_RESPONSE_PRESENT" };
  }

  const createdMs = Date.parse(input.lead.createdAt);
  const nowMs = Date.parse(input.nowIso);
  const elapsedMinutes = Math.floor((nowMs - createdMs) / 60_000);
  const threshold = input.config.responseGapThresholdMinutes;
  if (elapsedMinutes < threshold) {
    return {
      eligible: false,
      reasonCode: "THRESHOLD_NOT_ELAPSED",
      thresholdMinutes: threshold,
      elapsedMinutes,
    };
  }

  const gapDetectedAt = input.nowIso;
  const gapIdentityKey = recoveryGapIdentityKey({
    leadId: input.lead.leadId,
    leadCreatedAt: input.lead.createdAt,
    thresholdMinutes: threshold,
  });

  return {
    eligible: true,
    reasonCode: "GAP_DETECTED",
    gapDetectedAt,
    thresholdMinutes: threshold,
    elapsedMinutes,
    gapIdentityKey,
  };
}

/**
 * Same lead + same response-gap episode → same RecoveryCase identity.
 */
export function recoveryGapIdentityKey(input: {
  leadId: string;
  leadCreatedAt: string;
  thresholdMinutes: number;
}): string {
  return hashCanonical({
    leadId: input.leadId,
    episode: "INITIAL_NO_RESPONSE",
    leadCreatedAt: input.leadCreatedAt,
    thresholdMinutes: input.thresholdMinutes,
  });
}
