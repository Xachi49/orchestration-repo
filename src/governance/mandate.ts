import { createHash } from "node:crypto";
import { z } from "zod";
import { GovernanceQuorumRequirementSchema } from "./quorum.js";
import { SeparationOfDutyRuleSchema } from "./separation.js";

export const MANDATE_STATES = [
  "DRAFT",
  "ACTIVE",
  "SUSPENDED",
  "SUPERSEDED",
  "REVOKED",
] as const;

export type MandateState = (typeof MANDATE_STATES)[number];

export const GovernanceDelegationPolicySchema = z
  .object({
    allowDelegation: z.boolean().default(true),
    maximumDelegationDepth: z.number().int().nonnegative().default(1),
    redelegationForbidden: z.boolean().default(false),
  })
  .strict();

export type GovernanceDelegationPolicy = z.infer<
  typeof GovernanceDelegationPolicySchema
>;

export const GovernanceMandateSchema = z
  .object({
    mandateId: z.string().min(1),
    mandateVersion: z.number().int().positive(),
    institutionId: z.string().min(1),
    subjectClasses: z.array(z.string().min(1)).min(1),
    requiredAuthorities: z.array(z.string().min(1)).min(1),
    projectScope: z.array(z.string().min(1)).min(1),
    environmentScope: z.array(z.string().min(1)).min(1),
    quorumRequirement: GovernanceQuorumRequirementSchema.optional(),
    separationOfDutyRules: z.array(SeparationOfDutyRuleSchema).default([]),
    delegationPolicy: GovernanceDelegationPolicySchema.default({}),
    maximumAuthorityDurationMs: z.number().int().positive().optional(),
    maximumDelegationDepth: z.number().int().nonnegative().optional(),
    riskScope: z.array(z.string().min(1)).default([]),
    resourceScope: z.record(z.string(), z.number().finite()).default({}),
    effectiveFrom: z.string().datetime(),
    effectiveUntil: z.string().datetime().optional(),
    status: z.enum(MANDATE_STATES),
    mandateHash: z.string().min(1),
    createdBy: z.string().min(1),
    createdAt: z.string().datetime(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type GovernanceMandate = z.infer<typeof GovernanceMandateSchema>;

export function computeMandateHash(
  input: Omit<GovernanceMandate, "mandateHash" | "recordRevision">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        mandateId: input.mandateId,
        mandateVersion: input.mandateVersion,
        institutionId: input.institutionId,
        subjectClasses: [...input.subjectClasses].sort(),
        requiredAuthorities: [...input.requiredAuthorities].sort(),
        projectScope: [...input.projectScope].sort(),
        environmentScope: [...input.environmentScope].sort(),
        quorumRequirement: input.quorumRequirement ?? null,
        separationOfDutyRules: input.separationOfDutyRules,
        delegationPolicy: input.delegationPolicy,
        maximumAuthorityDurationMs: input.maximumAuthorityDurationMs ?? null,
        maximumDelegationDepth: input.maximumDelegationDepth ?? null,
        riskScope: [...input.riskScope].sort(),
        resourceScope: input.resourceScope,
        effectiveFrom: input.effectiveFrom,
        effectiveUntil: input.effectiveUntil ?? null,
        status: input.status,
        createdBy: input.createdBy,
        createdAt: input.createdAt,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withMandateHash(
  input: Omit<GovernanceMandate, "mandateHash">,
): GovernanceMandate {
  const { recordRevision, ...rest } = input;
  const mandateHash = computeMandateHash(rest);
  return GovernanceMandateSchema.parse({ ...input, mandateHash });
}

export function mintMandateId(input: {
  institutionId: string;
  createdAt: string;
}): string {
  return `gmd_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}

export function parseGovernanceMandate(raw: unknown): GovernanceMandate {
  return GovernanceMandateSchema.parse(raw);
}

/**
 * A mandate adds conditions around existing authority.
 * It never grants phase-specific roles.
 */
export const MANDATE_DOES_NOT_CREATE_AUTHORITY =
  "Mandate does NOT give anyone phase-specific authority. Phase gates remain required.";
