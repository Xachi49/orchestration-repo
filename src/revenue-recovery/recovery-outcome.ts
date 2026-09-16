import type { LeadEvent } from "./recovery-event.js";
import type { RecoveryCase, RecoveryCaseStatus } from "./recovery-case.js";
import { ACTIVE_RECOVERY_CASE_STATUSES } from "./recovery-case.js";

export const RECOVERY_OUTCOMES = [
  "ENGAGED",
  "APPOINTMENT_BOOKED",
  "CONVERTED",
  "UNRECOVERED",
  "SUPPRESSED",
  "INCONCLUSIVE",
] as const;

export type RecoveryOutcome = (typeof RECOVERY_OUTCOMES)[number];

/**
 * Deterministic outcome from authoritative lead/business events.
 * Model suggestion does not decide business outcome.
 *
 * WORKFLOW CONVERTED != CONFIRMED REVENUE. A CONVERTED outcome only states
 * that a sale/payment event exists in the lead timeline; whether that event
 * carries CONFIRMED_SALE / CONFIRMED_PAYMENT economics is decided solely by
 * server-assigned trust provenance in revenue attribution.
 */
export function evaluateRecoveryOutcome(input: {
  recoveryCase: RecoveryCase;
  events: readonly LeadEvent[];
}): {
  outcome: RecoveryOutcome;
  nextStatus: RecoveryCaseStatus;
  suppressionReason?: string;
} {
  const events = input.events;
  if (
    events.some((e) => e.kind === "DO_NOT_CONTACT" || e.kind === "CONSENT_REVOKED")
  ) {
    return {
      outcome: "SUPPRESSED",
      nextStatus: "SUPPRESSED",
      suppressionReason: events.some((e) => e.kind === "DO_NOT_CONTACT")
        ? "DO_NOT_CONTACT"
        : "CONSENT_REVOKED",
    };
  }
  if (events.some((e) => e.kind === "PAYMENT_RECORDED" || e.kind === "SALE_RECORDED")) {
    return { outcome: "CONVERTED", nextStatus: "CONVERTED" };
  }
  if (events.some((e) => e.kind === "APPOINTMENT_BOOKED")) {
    return {
      outcome: "APPOINTMENT_BOOKED",
      nextStatus: "APPOINTMENT_BOOKED",
    };
  }
  if (events.some((e) => e.kind === "INBOUND_MESSAGE" || e.kind === "CALL_CONNECTED")) {
    return { outcome: "ENGAGED", nextStatus: "ENGAGED" };
  }
  if (input.recoveryCase.status === "CLOSED_UNRECOVERED") {
    return { outcome: "UNRECOVERED", nextStatus: "CLOSED_UNRECOVERED" };
  }
  if (ACTIVE_RECOVERY_CASE_STATUSES.includes(input.recoveryCase.status)) {
    return { outcome: "INCONCLUSIVE", nextStatus: input.recoveryCase.status };
  }
  return {
    outcome: "INCONCLUSIVE",
    nextStatus: input.recoveryCase.status,
  };
}
