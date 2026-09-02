import { createHash } from "node:crypto";
import { z } from "zod";

export const REVOCATION_TARGET_TYPES = [
  "DIRECT_GRANT",
  "DELEGATION",
  "MANDATE",
  "INSTITUTIONAL_PROOF",
] as const;

export const AuthorityRevocationSchema = z
  .object({
    revocationId: z.string().min(1),
    targetType: z.enum(REVOCATION_TARGET_TYPES),
    targetId: z.string().min(1),
    reason: z.string().min(1).max(4000),
    effectiveAt: z.string().datetime(),
    principalId: z.string().min(1),
    revocationHash: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export type AuthorityRevocation = z.infer<typeof AuthorityRevocationSchema>;

export function computeRevocationHash(
  input: Omit<AuthorityRevocation, "revocationHash">,
): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function withRevocationHash(
  input: Omit<AuthorityRevocation, "revocationHash">,
): AuthorityRevocation {
  const revocationHash = computeRevocationHash(input);
  return AuthorityRevocationSchema.parse({ ...input, revocationHash });
}

export function mintRevocationId(input: {
  targetType: string;
  targetId: string;
  effectiveAt: string;
}): string {
  return `arev_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}

export const HOLD_STATES = ["ACTIVE", "RELEASED", "EXPIRED"] as const;

export const GovernanceHoldSchema = z
  .object({
    holdId: z.string().min(1),
    institutionId: z.string().min(1),
    projectScope: z.array(z.string().min(1)).min(1),
    environmentScope: z.array(z.string().min(1)).default([]),
    subjectClasses: z.array(z.string().min(1)).default([]),
    authorityRoles: z.array(z.string().min(1)).default([]),
    reason: z.string().min(1).max(4000),
    effect: z.enum(["BLOCK", "PAUSE", "CONTAIN"]).default("BLOCK"),
    effectiveFrom: z.string().datetime(),
    effectiveUntil: z.string().datetime().optional(),
    createdBy: z.string().min(1),
    status: z.enum(HOLD_STATES),
    holdHash: z.string().min(1),
    createdAt: z.string().datetime(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type GovernanceHold = z.infer<typeof GovernanceHoldSchema>;

export function computeHoldHash(
  input: Omit<GovernanceHold, "holdHash" | "recordRevision" | "status"> & {
    status?: string;
  },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        holdId: input.holdId,
        institutionId: input.institutionId,
        projectScope: [...input.projectScope].sort(),
        environmentScope: [...(input.environmentScope ?? [])].sort(),
        subjectClasses: [...(input.subjectClasses ?? [])].sort(),
        authorityRoles: [...(input.authorityRoles ?? [])].sort(),
        reason: input.reason,
        effect: input.effect,
        effectiveFrom: input.effectiveFrom,
        effectiveUntil: input.effectiveUntil ?? null,
        createdBy: input.createdBy,
        createdAt: input.createdAt,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withHoldHash(
  input: Omit<GovernanceHold, "holdHash">,
): GovernanceHold {
  const holdHash = computeHoldHash(input);
  return GovernanceHoldSchema.parse({ ...input, holdHash });
}

export function mintHoldId(input: {
  institutionId: string;
  createdAt: string;
}): string {
  return `ghold_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}

export const HOLD_CANNOT_GRANT =
  "GovernanceHold may BLOCK/PAUSE/CONTAIN only. It may NOT grant, approve, or execute.";
