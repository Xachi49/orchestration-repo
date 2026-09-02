import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Direct institutional authority grant (test + durable seed projection).
 * Does not replace Phase authority directory — used for governance resolution.
 */
export const DirectAuthorityGrantSchema = z
  .object({
    grantId: z.string().min(1),
    principalId: z.string().min(1),
    authorityRole: z.string().min(1),
    institutionId: z.string().min(1),
    projectScope: z.array(z.string().min(1)).min(1),
    environmentScope: z.array(z.string().min(1)).min(1),
    actionScope: z.array(z.string().min(1)).default([]),
    effectiveFrom: z.string().datetime(),
    effectiveUntil: z.string().datetime(),
    maximumRisk: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    maximumResourceEnvelope: z
      .record(z.string(), z.number().finite().nonnegative())
      .default({}),
    status: z.enum(["ACTIVE", "REVOKED", "EXPIRED"]).default("ACTIVE"),
    createdAt: z.string().datetime(),
  })
  .strict();

export type DirectAuthorityGrant = z.infer<typeof DirectAuthorityGrantSchema>;

export function mintDirectGrantId(input: {
  principalId: string;
  authorityRole: string;
  createdAt: string;
}): string {
  return `dagr_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}

export const GovernanceAuditEventSchema = z
  .object({
    auditEventId: z.string().min(1),
    eventType: z.string().min(1),
    institutionId: z.string().min(1).optional(),
    subjectIds: z.array(z.string().min(1)).default([]),
    principalId: z.string().min(1).optional(),
    payload: z.record(z.string(), z.unknown()).default({}),
    createdAt: z.string().datetime(),
  })
  .strict();

export type GovernanceAuditEvent = z.infer<typeof GovernanceAuditEventSchema>;

export function mintAuditEventId(input: {
  eventType: string;
  createdAt: string;
}): string {
  return `gaud_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}
