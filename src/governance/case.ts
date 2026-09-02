import { createHash } from "node:crypto";
import { z } from "zod";
import { GovernanceQuorumRequirementSchema } from "./quorum.js";
import { SeparationOfDutyRuleSchema } from "./separation.js";

export const GOVERNANCE_CASE_STATES = [
  "OPEN",
  "COLLECTING",
  "SATISFIED",
  "BLOCKED",
  "EXPIRED",
  "CANCELLED",
  "STALE",
] as const;

export type GovernanceCaseState = (typeof GOVERNANCE_CASE_STATES)[number];

export const GovernanceCaseSchema = z
  .object({
    governanceCaseId: z.string().min(1),
    caseVersion: z.number().int().positive(),
    subjectType: z.string().min(1),
    subjectId: z.string().min(1),
    subjectVersion: z.number().int().positive().optional(),
    subjectHash: z.string().min(1),
    requiredRole: z.string().min(1),
    action: z.string().min(1).optional(),
    projectIds: z.array(z.string().min(1)).min(1),
    environmentScope: z.array(z.string().min(1)).min(1),
    mandateIds: z.array(z.string().min(1)).min(1),
    mandateVersions: z.array(z.number().int().positive()).default([]),
    mandateHashes: z.array(z.string().min(1)).default([]),
    quorumRequirement: GovernanceQuorumRequirementSchema,
    separationRules: z.array(SeparationOfDutyRuleSchema).default([]),
    status: z.enum(GOVERNANCE_CASE_STATES),
    expiresAt: z.string().datetime(),
    caseHash: z.string().min(1),
    institutionalProofId: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type GovernanceCase = z.infer<typeof GovernanceCaseSchema>;

export function computeCaseHash(
  input: Omit<
    GovernanceCase,
    "caseHash" | "recordRevision" | "institutionalProofId" | "status"
  > & { status?: GovernanceCaseState },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        governanceCaseId: input.governanceCaseId,
        caseVersion: input.caseVersion,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        subjectVersion: input.subjectVersion ?? null,
        subjectHash: input.subjectHash,
        requiredRole: input.requiredRole,
        action: input.action ?? null,
        projectIds: [...input.projectIds].sort(),
        environmentScope: [...input.environmentScope].sort(),
        mandateIds: [...input.mandateIds].sort(),
        mandateVersions: input.mandateVersions,
        mandateHashes: [...input.mandateHashes].sort(),
        quorumRequirement: input.quorumRequirement,
        separationRules: input.separationRules,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withCaseHash(
  input: Omit<GovernanceCase, "caseHash">,
): GovernanceCase {
  const caseHash = computeCaseHash(input);
  return GovernanceCaseSchema.parse({ ...input, caseHash });
}

export function mintGovernanceCaseId(input: {
  subjectId: string;
  createdAt: string;
}): string {
  return `gcase_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}

/**
 * SATISFIED means institutional conditions were satisfied —
 * not that the business action happened.
 */
export const CASE_SATISFIED_NOT_BUSINESS_ACTION =
  "SATISFIED != business action completed";

export const GovernanceAttestationSchema = z
  .object({
    attestationId: z.string().min(1),
    governanceCaseId: z.string().min(1),
    principalId: z.string().min(1),
    authorityRole: z.string().min(1),
    authoritySnapshotId: z.string().min(1),
    authoritySnapshotHash: z.string().min(1),
    decision: z.enum(["APPROVE", "REJECT"]),
    nonceHash: z.string().min(1),
    submittedAt: z.string().datetime(),
    attestationHash: z.string().min(1),
  })
  .strict();

export type GovernanceAttestation = z.infer<typeof GovernanceAttestationSchema>;

export function computeAttestationHash(
  input: Omit<GovernanceAttestation, "attestationHash">,
): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function withAttestationHash(
  input: Omit<GovernanceAttestation, "attestationHash">,
): GovernanceAttestation {
  const attestationHash = computeAttestationHash(input);
  return GovernanceAttestationSchema.parse({ ...input, attestationHash });
}

export function mintAttestationId(input: {
  governanceCaseId: string;
  principalId: string;
  authorityRole: string;
}): string {
  return `gatt_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}

/** Logical attestation identity for idempotency. */
export function attestationLogicalKey(input: {
  governanceCaseId: string;
  principalId: string;
  authorityRole: string;
}): string {
  return `${input.governanceCaseId}:${input.principalId}:${input.authorityRole}`;
}
