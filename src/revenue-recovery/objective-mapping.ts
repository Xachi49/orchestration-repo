import type { AdmissionRequest } from "../admission/request.js";
import type { Lead } from "./lead.js";
import type { RecoveryCase } from "./recovery-case.js";
import type { RecoveryConfiguration } from "./recovery-config.js";
import type { ContactPolicyResult } from "./contact-policy.js";

/**
 * Maps a recovery case into a canonical Phase 2 admission request.
 * Does not admit — caller uses ObjectiveAdmissionService.
 */
export function mapRecoveryCaseToAdmissionRequest(input: {
  recoveryCase: RecoveryCase;
  lead: Lead;
  config: RecoveryConfiguration;
  contactPolicy: ContactPolicyResult;
  requesterId: string;
  requestedEnvironment: string;
  submittedAt: string;
  objectiveVersion?: number;
}): AdmissionRequest {
  const version = input.objectiveVersion ?? 1;
  const objectiveId = `obj_rr_${input.recoveryCase.recoveryCaseId}`;
  const allowedChannels = input.contactPolicy.channels
    .filter((c) => c.permitted)
    .map((c) => c.channel);

  return {
    projectId: input.recoveryCase.projectId,
    objectiveId,
    objectiveVersion: version,
    requestedOutcome:
      "Recover engagement or appointment opportunity for an unanswered service lead",
    acceptanceCriteria: [
      "Lead responds to recovery outreach",
      "Appointment booked",
      "Lead explicitly declines",
      "Contact policy exhausts allowed attempts",
    ],
    constraints: [
      `Allowed channels: ${allowedChannels.join(",") || "NONE"}`,
      `Max SMS attempts: ${input.config.maxSmsAttempts}`,
      `Max email attempts: ${input.config.maxEmailAttempts}`,
      `Contact window: ${input.config.contactWindow.startHourLocal}-${input.config.contactWindow.endHourLocal} ${input.config.timezone}`,
      "No contact after opt-out / DO_NOT_CONTACT",
      "Recipient must match canonical lead channel",
      "No arbitrary upselling",
    ],
    nonGoals: [
      "Arbitrary upselling",
      "Contacting unrelated recipients",
      "Editing CRM beyond bounded recovery state",
      "Unapproved monetary offers",
      "Unbounded automated contact",
    ],
    priority: "HIGH",
    requesterId: input.requesterId,
    requestedEnvironment: input.requestedEnvironment,
    submittedAt: input.submittedAt,
  };
}

export function recoveryPlanningContext(input: {
  lead: Lead;
  recoveryCase: RecoveryCase;
  config: RecoveryConfiguration;
  contactPolicy: ContactPolicyResult;
  priorAttemptCount: number;
}): Record<string, unknown> {
  return {
    dataClassification: "UNTRUSTED_EXTERNAL_CRM_METADATA",
    doctrine: "RESPONSE GAP != AUTHORIZATION TO CONTACT",
    leadId: input.lead.leadId,
    serviceRequested: input.lead.serviceRequested ?? null,
    serviceArea: input.lead.serviceArea ?? null,
    estimatedValue: input.lead.estimatedValue ?? null,
    currency: input.lead.currency ?? input.config.currency,
    gapDetectedAt: input.recoveryCase.gapDetectedAt,
    contactPolicyEligible: input.contactPolicy.eligible,
    permittedChannels: input.contactPolicy.channels
      .filter((c) => c.permitted)
      .map((c) => c.channel),
    priorAttemptCount: input.priorAttemptCount,
    businessName: input.config.businessName,
    bookingLink: input.config.bookingLink ?? null,
    configVersion: input.config.configVersion,
    // PII omitted from planning context by default
    hasPhone: Boolean(input.lead.phone),
    hasEmail: Boolean(input.lead.email),
  };
}
