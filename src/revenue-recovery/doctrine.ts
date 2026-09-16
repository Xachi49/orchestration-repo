/**
 * Continuum Revenue — Revenue Recovery Engine (product vertical).
 * NOT Phase 25. Built on orchestrator Phases 0–24.
 *
 * RECOVERY ENGINE != CRM SOURCE OF TRUTH
 * CONTROL TOWER != AUTHORITY
 * RESPONSE GAP != AUTHORIZATION TO CONTACT
 */
export const REVENUE_RECOVERY_DOCTRINE = {
  leadNotOpportunity: "LEAD != OPPORTUNITY",
  noResponseNotLost: "NO RESPONSE != LOST LEAD",
  gapNotAuthorization: "RESPONSE GAP != AUTHORIZATION TO CONTACT",
  contactableNotAuthorized: "CONTACTABLE != AUTHORIZED ACTION",
  planNotOutreach: "PLAN != OUTREACH",
  outreachNotEngaged: "OUTREACH SENT != LEAD ENGAGED",
  engagedNotAppointment: "LEAD ENGAGED != APPOINTMENT",
  appointmentNotRevenue: "APPOINTMENT != REVENUE",
  claimNotAttributed: "REVENUE CLAIM != ATTRIBUTED REVENUE",
  attributedNotCollected: "ATTRIBUTED REVENUE != CASH COLLECTED",
  automationNotUnbounded: "AUTOMATION != UNBOUNDED CONTACT",
  recoveryNotCrmTruth: "RECOVERY ENGINE != CRM SOURCE OF TRUTH",
  modelNotConsent: "MODEL SUGGESTION != CONTACT CONSENT",
  controlTowerNotAuthority: "CONTROL TOWER != AUTHORITY",
  estimatedNotBooked: "ESTIMATED RECOVERABLE VALUE != BOOKED REVENUE",
  bookedNotCollected: "BOOKED REVENUE != COLLECTED REVENUE",
  attestedNotConfirmed: "OPERATOR ATTESTATION != CONFIRMED REVENUE",
  eventKindNotProvenance: "EVENT KIND != TRUST PROVENANCE",
  callerAssertionNotAuthorization: "CALLER ASSERTION != AUTHORIZATION",
  convertedNotConfirmedRevenue: "WORKFLOW CONVERTED != CONFIRMED REVENUE",
} as const;

/** Absolute safety ceilings — tenant config cannot exceed these. */
export const RECOVERY_SAFETY_CEILINGS = {
  maxSmsAttempts: 5,
  maxEmailAttempts: 5,
  maxCallTasks: 5,
  maxCooldownMinutes: 7 * 24 * 60,
  maxAttributionWindowDays: 90,
  maxResponseGapThresholdMinutes: 24 * 60,
  maxRecoveryAgeDays: 90,
} as const;

export const REVENUE_RECOVERY_PRODUCT_ID = "continuum-revenue-recovery-engine";
export const REVENUE_RECOVERY_SCHEMA_MIGRATION =
  "022_product_revenue_recovery_live_pilot" as const;
