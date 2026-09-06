import { createHash } from "node:crypto";
import { z } from "zod";

export const INSTITUTION_STATES = [
  "ACTIVE",
  "SUSPENDED",
  "RETIRED",
] as const;

export type InstitutionState = (typeof INSTITUTION_STATES)[number];

export const InstitutionSchema = z
  .object({
    institutionId: z.string().min(1),
    name: z.string().min(1).max(500),
    projectIds: z.array(z.string().min(1)).default([]),
    organizationalUnitIds: z.array(z.string().min(1)).default([]),
    /** When true, protected governance mutations require Phase 21 activation context. */
    constitutionalControlEnabled: z.boolean().default(false),
    createdAt: z.string().datetime(),
    status: z.enum(INSTITUTION_STATES),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type Institution = z.infer<typeof InstitutionSchema>;

export function mintInstitutionId(input: {
  name: string;
  createdAt: string;
}): string {
  return `inst_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}

export function parseInstitution(raw: unknown): Institution {
  return InstitutionSchema.parse(raw);
}

export const ORGANIZATIONAL_UNIT_STATES = [
  "ACTIVE",
  "SUSPENDED",
  "RETIRED",
] as const;

export const OrganizationalUnitSchema = z
  .object({
    organizationalUnitId: z.string().min(1),
    institutionId: z.string().min(1),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(""),
    projectScope: z.array(z.string().min(1)).default([]),
    parentUnitId: z.string().min(1).optional(),
    status: z.enum(ORGANIZATIONAL_UNIT_STATES),
  })
  .strict();

export type OrganizationalUnit = z.infer<typeof OrganizationalUnitSchema>;

/** Membership alone never implies permission. */
export const MEMBERSHIP_NOT_PERMISSION =
  "Membership != permission. Do not infer authority from unit membership alone.";

export function mintOrganizationalUnitId(input: {
  institutionId: string;
  name: string;
}): string {
  return `ou_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}
