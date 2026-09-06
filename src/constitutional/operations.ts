import { z } from "zod";
import { GovernanceQuorumRequirementSchema } from "../governance/quorum.js";
import { SeparationOfDutyRuleSchema } from "../governance/separation.js";
import { GovernanceDelegationPolicySchema } from "../governance/mandate.js";

const CreateMandateVersionOp = z
  .object({
    kind: z.literal("CREATE_MANDATE_VERSION"),
    institutionId: z.string().min(1),
    subjectClasses: z.array(z.string().min(1)).min(1),
    requiredAuthorities: z.array(z.string().min(1)).min(1),
    projectScope: z.array(z.string().min(1)).min(1),
    environmentScope: z.array(z.string().min(1)).min(1),
    quorumRequirement: GovernanceQuorumRequirementSchema.optional(),
    separationOfDutyRules: z.array(SeparationOfDutyRuleSchema).default([]),
    delegationPolicy: GovernanceDelegationPolicySchema.optional(),
    maximumDelegationDepth: z.number().int().nonnegative().optional(),
    effectiveFrom: z.string().datetime().optional(),
    effectiveUntil: z.string().datetime().optional(),
    mandateVersion: z.number().int().positive().optional(),
    selfGrantOperationalAuthority: z.boolean().default(false),
  })
  .strict();

const SupersedeMandateVersionOp = z
  .object({
    kind: z.literal("SUPERSEDE_MANDATE_VERSION"),
    mandateId: z.string().min(1),
    newMandateVersion: z.number().int().positive(),
    subjectClasses: z.array(z.string().min(1)).min(1),
    requiredAuthorities: z.array(z.string().min(1)).min(1),
    projectScope: z.array(z.string().min(1)).min(1),
    environmentScope: z.array(z.string().min(1)).min(1),
    quorumRequirement: GovernanceQuorumRequirementSchema.optional(),
    separationOfDutyRules: z.array(SeparationOfDutyRuleSchema).default([]),
    delegationPolicy: GovernanceDelegationPolicySchema.optional(),
    maximumDelegationDepth: z.number().int().nonnegative().optional(),
    effectiveFrom: z.string().datetime().optional(),
    effectiveUntil: z.string().datetime().optional(),
  })
  .strict();

const ChangeMandateQuorumOp = z
  .object({
    kind: z.literal("CHANGE_MANDATE_QUORUM"),
    mandateId: z.string().min(1),
    quorumRequirement: GovernanceQuorumRequirementSchema,
    deleteHistoricalRecords: z.boolean().default(false),
  })
  .strict();

const ChangeMandateSeparationOp = z
  .object({
    kind: z.literal("CHANGE_MANDATE_SEPARATION_OF_DUTIES"),
    mandateId: z.string().min(1),
    separationOfDutyRules: z.array(SeparationOfDutyRuleSchema),
  })
  .strict();

const ChangeMandateScopeOp = z
  .object({
    kind: z.literal("CHANGE_MANDATE_SCOPE"),
    mandateId: z.string().min(1),
    projectScope: z.array(z.string().min(1)).min(1),
    environmentScope: z.array(z.string().min(1)).min(1),
    grantAuthorityViaHold: z.boolean().default(false),
  })
  .strict();

const ChangeDelegationLimitsOp = z
  .object({
    kind: z.literal("CHANGE_DELEGATION_LIMITS"),
    mandateId: z.string().min(1),
    maximumDelegationDepth: z.number().int().nonnegative(),
    delegationPolicy: GovernanceDelegationPolicySchema.optional(),
  })
  .strict();

const ChangeGovernanceAdminScopeOp = z
  .object({
    kind: z.literal("CHANGE_GOVERNANCE_ADMIN_SCOPE"),
    institutionId: z.string().min(1),
    /** Constitutional binding of institution project scope — NOT authority_grants mutation. */
    projectScope: z.array(z.string().min(1)).min(1),
  })
  .strict();

const CreateOrganizationalUnitOp = z
  .object({
    kind: z.literal("CREATE_ORGANIZATIONAL_UNIT"),
    institutionId: z.string().min(1),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(""),
    projectScope: z.array(z.string().min(1)).default([]),
    parentUnitId: z.string().min(1).optional(),
  })
  .strict();

const ChangeOrganizationalUnitRelationshipOp = z
  .object({
    kind: z.literal("CHANGE_ORGANIZATIONAL_UNIT_RELATIONSHIP"),
    organizationalUnitId: z.string().min(1),
    parentUnitId: z.string().min(1).optional(),
  })
  .strict();

const RetireOrganizationalUnitOp = z
  .object({
    kind: z.literal("RETIRE_ORGANIZATIONAL_UNIT"),
    organizationalUnitId: z.string().min(1),
  })
  .strict();

export const ConstitutionalChangeOperationSchema = z.discriminatedUnion(
  "kind",
  [
    CreateMandateVersionOp,
    SupersedeMandateVersionOp,
    ChangeMandateQuorumOp,
    ChangeMandateSeparationOp,
    ChangeMandateScopeOp,
    ChangeDelegationLimitsOp,
    ChangeGovernanceAdminScopeOp,
    CreateOrganizationalUnitOp,
    ChangeOrganizationalUnitRelationshipOp,
    RetireOrganizationalUnitOp,
  ],
);

export type ConstitutionalChangeOperation = z.infer<
  typeof ConstitutionalChangeOperationSchema
>;

export const ConstitutionalRiskClassSchema = z.enum([
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
]);

export type ConstitutionalRiskClass = z.infer<
  typeof ConstitutionalRiskClassSchema
>;
