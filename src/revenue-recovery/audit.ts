import { z } from "zod";
import { hashCanonical } from "./hash.js";

export const PRODUCT_AUDIT_EVENT_KINDS = [
  "LEAD_INGESTED",
  "RESPONSE_GAP_DETECTED",
  "RECOVERY_CASE_OPENED",
  "RECOVERY_OBJECTIVE_ADMITTED",
  "RECOVERY_PLAN_READY",
  "RECOVERY_APPROVED",
  "RECOVERY_ATTEMPT_SENT",
  "RECOVERY_RESPONSE_RECEIVED",
  "RECOVERY_APPOINTMENT_BOOKED",
  "RECOVERY_SALE_RECORDED",
  "RECOVERED_REVENUE_ATTRIBUTED",
  "RECOVERY_CLOSED",
] as const;

export type ProductAuditEventKind = (typeof PRODUCT_AUDIT_EVENT_KINDS)[number];

export const ProductAuditEventSchema = z
  .object({
    eventId: z.string().min(1),
    kind: z.enum(PRODUCT_AUDIT_EVENT_KINDS),
    customerAccountId: z.string().min(1),
    projectId: z.string().min(1),
    leadId: z.string().min(1).optional(),
    recoveryCaseId: z.string().min(1).optional(),
    occurredAt: z.string().datetime(),
    payload: z
      .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
  })
  .strict();

export type ProductAuditEvent = z.infer<typeof ProductAuditEventSchema>;

export function newAuditEventId(input: {
  kind: string;
  occurredAt: string;
  recoveryCaseId?: string;
  leadId?: string;
}): string {
  return `raud_${hashCanonical(input).slice(0, 24)}`;
}
