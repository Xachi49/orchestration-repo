import type { Lead } from "./lead.js";
import type { LeadEvent } from "./recovery-event.js";
import {
  SUPPRESSION_EVENT_KINDS,
  QUALIFYING_HUMAN_RESPONSE_KINDS,
} from "./recovery-event.js";
import type { RecoveryChannel, RecoveryConfiguration } from "./recovery-config.js";
import { isWithinContactWindow } from "./recovery-config.js";
import type { RecoveryAttempt } from "./recovery-attempt.js";

export type ContactPolicyReasonCode =
  | "ELIGIBLE"
  | "DO_NOT_CONTACT"
  | "CONSENT_REVOKED"
  | "CHANNEL_NOT_ALLOWED"
  | "CHANNEL_MISSING"
  | "CONSENT_MISSING"
  | "ATTEMPT_LIMIT_REACHED"
  | "COOLDOWN_ACTIVE"
  | "CONTACT_WINDOW_CLOSED"
  | "RECOVERY_AGE_EXCEEDED"
  | "CONFIG_DISABLED"
  | "LEAD_ALREADY_RESPONDED"
  | "APPOINTMENT_OR_CONVERSION_PRESENT"
  | "CASE_NOT_ACTIVE";

export type ContactPolicyChannelResult = {
  channel: RecoveryChannel;
  permitted: boolean;
  reasonCodes: ContactPolicyReasonCode[];
};

export type ContactPolicyResult = {
  eligible: boolean;
  channels: ContactPolicyChannelResult[];
  reasonCodes: ContactPolicyReasonCode[];
  evaluatedAt: string;
};

export function evaluateContactPolicy(input: {
  lead: Lead;
  events: readonly LeadEvent[];
  attempts: readonly RecoveryAttempt[];
  config: RecoveryConfiguration;
  nowIso: string;
  gapDetectedAt: string;
  /** When true, qualifying response / appointment / sale blocks further outreach. */
  suppressFollowUpOnResponse?: boolean;
  caseStatus?: string;
}): ContactPolicyResult {
  const reasonCodes: ContactPolicyReasonCode[] = [];
  if (!input.config.enabled) {
    return {
      eligible: false,
      channels: [],
      reasonCodes: ["CONFIG_DISABLED"],
      evaluatedAt: input.nowIso,
    };
  }

  if (
    input.caseStatus === "SUPPRESSED" ||
    input.caseStatus === "CLOSED_UNRECOVERED" ||
    input.caseStatus === "CONVERTED"
  ) {
    return {
      eligible: false,
      channels: [],
      reasonCodes: ["CASE_NOT_ACTIVE"],
      evaluatedAt: input.nowIso,
    };
  }

  const dnc =
    input.lead.consent?.doNotContact === true ||
    input.events.some((e) => SUPPRESSION_EVENT_KINDS.includes(e.kind));
  if (dnc) {
    return {
      eligible: false,
      channels: input.config.allowedChannels.map((channel) => ({
        channel,
        permitted: false,
        reasonCodes: ["DO_NOT_CONTACT"] as ContactPolicyReasonCode[],
      })),
      reasonCodes: ["DO_NOT_CONTACT"],
      evaluatedAt: input.nowIso,
    };
  }

  if (input.lead.consent?.consentRevokedAt) {
    return {
      eligible: false,
      channels: input.config.allowedChannels.map((channel) => ({
        channel,
        permitted: false,
        reasonCodes: ["CONSENT_REVOKED"] as ContactPolicyReasonCode[],
      })),
      reasonCodes: ["CONSENT_REVOKED"],
      evaluatedAt: input.nowIso,
    };
  }

  if (input.suppressFollowUpOnResponse !== false) {
    if (
      input.events.some(
        (e) =>
          e.kind === "APPOINTMENT_BOOKED" ||
          e.kind === "SALE_RECORDED" ||
          e.kind === "PAYMENT_RECORDED",
      )
    ) {
      return {
        eligible: false,
        channels: [],
        reasonCodes: ["APPOINTMENT_OR_CONVERSION_PRESENT"],
        evaluatedAt: input.nowIso,
      };
    }
    if (
      input.events.some(
        (e) => e.kind === "INBOUND_MESSAGE" || e.kind === "CALL_CONNECTED",
      )
    ) {
      return {
        eligible: false,
        channels: [],
        reasonCodes: ["LEAD_ALREADY_RESPONDED"],
        evaluatedAt: input.nowIso,
      };
    }
  }

  const gapMs =
    Date.parse(input.nowIso) - Date.parse(input.gapDetectedAt);
  const maxAgeMs = input.config.maximumRecoveryAgeDays * 24 * 60 * 60 * 1000;
  if (gapMs > maxAgeMs) {
    reasonCodes.push("RECOVERY_AGE_EXCEEDED");
  }

  const inWindow = isWithinContactWindow(input.nowIso, input.config);
  if (!inWindow) {
    reasonCodes.push("CONTACT_WINDOW_CLOSED");
  }

  const channels: ContactPolicyChannelResult[] = [];
  for (const channel of input.config.allowedChannels) {
    const channelReasons: ContactPolicyReasonCode[] = [];
    if (!inWindow) channelReasons.push("CONTACT_WINDOW_CLOSED");
    if (reasonCodes.includes("RECOVERY_AGE_EXCEEDED")) {
      channelReasons.push("RECOVERY_AGE_EXCEEDED");
    }

    if (channel === "SMS") {
      if (!input.lead.phone) channelReasons.push("CHANNEL_MISSING");
      if (input.lead.consent?.smsOptIn === false) {
        channelReasons.push("CONSENT_MISSING");
      }
      const smsCount = input.attempts.filter((a) => a.channel === "SMS").length;
      if (smsCount >= input.config.maxSmsAttempts) {
        channelReasons.push("ATTEMPT_LIMIT_REACHED");
      }
    }
    if (channel === "EMAIL") {
      if (!input.lead.email) channelReasons.push("CHANNEL_MISSING");
      if (input.lead.consent?.emailOptIn === false) {
        channelReasons.push("CONSENT_MISSING");
      }
      const emailCount = input.attempts.filter(
        (a) => a.channel === "EMAIL",
      ).length;
      if (emailCount >= input.config.maxEmailAttempts) {
        channelReasons.push("ATTEMPT_LIMIT_REACHED");
      }
    }
    if (channel === "CALL_TASK") {
      if (!input.lead.phone) channelReasons.push("CHANNEL_MISSING");
      if (input.lead.consent?.callOptIn === false) {
        channelReasons.push("CONSENT_MISSING");
      }
      const callCount = input.attempts.filter(
        (a) => a.channel === "CALL_TASK",
      ).length;
      if (callCount >= input.config.maxCallTasks) {
        channelReasons.push("ATTEMPT_LIMIT_REACHED");
      }
    }

    const lastAttempt = [...input.attempts]
      .filter((a) => a.channel === channel)
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0];
    if (lastAttempt && input.config.cooldownMinutes > 0) {
      const elapsed =
        Date.parse(input.nowIso) - Date.parse(lastAttempt.sentAt);
      if (elapsed < input.config.cooldownMinutes * 60_000) {
        channelReasons.push("COOLDOWN_ACTIVE");
      }
    }

    channels.push({
      channel,
      permitted: channelReasons.length === 0,
      reasonCodes:
        channelReasons.length === 0 ? ["ELIGIBLE"] : channelReasons,
    });
  }

  const anyPermitted = channels.some((c) => c.permitted);
  if (!anyPermitted && reasonCodes.length === 0) {
    reasonCodes.push("CHANNEL_NOT_ALLOWED");
  }

  return {
    eligible: anyPermitted,
    channels,
    reasonCodes: anyPermitted
      ? ["ELIGIBLE"]
      : [...new Set(reasonCodes.length ? reasonCodes : ["CONTACT_NOT_PERMITTED" as ContactPolicyReasonCode])],
    evaluatedAt: input.nowIso,
  };
}

export function hasQualifyingHumanResponse(
  events: readonly LeadEvent[],
): boolean {
  return events.some((e) => QUALIFYING_HUMAN_RESPONSE_KINDS.includes(e.kind));
}
