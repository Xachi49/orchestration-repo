import { z } from "zod";

export const QUALIFICATION_AUDIT_EVENT_TYPES = [
  "QUALIFICATION_RUN_CREATED",
  "READINESS_EVALUATED",
  "EVIDENCE_RECORDED",
  "QUALIFICATION_DECIDED",
  "RELEASE_RECORD_ISSUED",
  "RELEASE_MANIFEST_EMITTED",
  "CANDIDATE_DRIFT_DETECTED",
  "CERTIFICATE_BINDING_REJECTED",
] as const;

export type QualificationAuditEventType =
  (typeof QUALIFICATION_AUDIT_EVENT_TYPES)[number];

export const QualificationAuditEventSchema = z
  .object({
    auditEventId: z.string().min(1),
    eventType: z.enum(QUALIFICATION_AUDIT_EVENT_TYPES),
    qualificationRunId: z.string().min(1).optional(),
    recordId: z.string().min(1).optional(),
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime(),
  })
  .strict();

export type QualificationAuditEvent = z.infer<
  typeof QualificationAuditEventSchema
>;
