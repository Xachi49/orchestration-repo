import { z } from "zod";

export const ASSURANCE_AUDIT_EVENT_TYPES = [
  "ASSURANCE_RUN_CREATED",
  "CHALLENGE_PLAN_COMPILED",
  "EVIDENCE_RECORDED",
  "CONTROL_EVALUATED",
  "FINDING_RECORDED",
  "ASSESSMENT_FINALIZED",
  "CERTIFICATION_DECIDED",
  "CERTIFICATE_ISSUED",
  "CERTIFICATE_REVOKED",
  "TARGET_DRIFT_DETECTED",
] as const;

export type AssuranceAuditEventType =
  (typeof ASSURANCE_AUDIT_EVENT_TYPES)[number];

export const AssuranceAuditEventSchema = z
  .object({
    auditEventId: z.string().min(1),
    eventType: z.enum(ASSURANCE_AUDIT_EVENT_TYPES),
    assuranceRunId: z.string().min(1).optional(),
    certificateId: z.string().min(1).optional(),
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime(),
  })
  .strict();

export type AssuranceAuditEvent = z.infer<typeof AssuranceAuditEventSchema>;
