import { createHash } from "node:crypto";
import { z } from "zod";

export const AuthorityResolutionOutcomeSchema = z.enum([
  "AUTHORIZED",
  "DENIED",
  "CONDITIONAL",
]);

export type AuthorityResolutionOutcome = z.infer<
  typeof AuthorityResolutionOutcomeSchema
>;

export const InstitutionalAuthorityResolutionSchema = z
  .object({
    outcome: AuthorityResolutionOutcomeSchema,
    principalId: z.string().min(1),
    requiredRole: z.string().min(1),
    projectId: z.string().min(1),
    environment: z.string().min(1),
    directGrantIds: z.array(z.string().min(1)).default([]),
    delegationChain: z.array(z.string().min(1)).default([]),
    mandateIds: z.array(z.string().min(1)).default([]),
    mandateVersions: z.array(z.number().int().positive()).default([]),
    mandateHashes: z.array(z.string().min(1)).default([]),
    scope: z
      .object({
        projectIds: z.array(z.string().min(1)),
        environments: z.array(z.string().min(1)),
        effectiveFrom: z.string().datetime().optional(),
        effectiveUntil: z.string().datetime().optional(),
      })
      .strict(),
    reasons: z.array(z.string()).default([]),
    sourceAuthorityFingerprint: z.string().min(1),
    institutionalAuthorityFingerprint: z.string().min(1),
    /** Wall-clock observation only — NOT part of fingerprint material. */
    resolvedAt: z.string().datetime(),
  })
  .strict();

export type InstitutionalAuthorityResolution = z.infer<
  typeof InstitutionalAuthorityResolutionSchema
>;

export const InstitutionalAuthoritySnapshotSchema = z
  .object({
    authoritySnapshotId: z.string().min(1),
    principalId: z.string().min(1),
    role: z.string().min(1),
    projectId: z.string().min(1),
    environment: z.string().min(1),
    directGrantIds: z.array(z.string().min(1)).default([]),
    delegationChain: z.array(z.string().min(1)).default([]),
    mandateIds: z.array(z.string().min(1)).default([]),
    mandateHashes: z.array(z.string().min(1)).default([]),
    revocationIds: z.array(z.string().min(1)).default([]),
    holdIds: z.array(z.string().min(1)).default([]),
    resolvedScope: z
      .object({
        projectIds: z.array(z.string().min(1)),
        environments: z.array(z.string().min(1)),
      })
      .strict(),
    sourceAuthorityFingerprint: z.string().min(1),
    institutionalAuthorityFingerprint: z.string().min(1),
    snapshotHash: z.string().min(1),
  })
  .strict();

export type InstitutionalAuthoritySnapshot = z.infer<
  typeof InstitutionalAuthoritySnapshotSchema
>;

/**
 * Material fingerprint binds stable authority inputs.
 * Do NOT include volatile resolution wall-clock timestamps.
 */
export function computeAuthorityFingerprint(input: {
  principalId: string;
  role: string;
  projectId: string;
  environment: string;
  directGrantIds: readonly string[];
  delegationChain: readonly string[];
  mandateIds: readonly string[];
  mandateHashes: readonly string[];
  revocationIds: readonly string[];
  holdIds: readonly string[];
  projectScope: readonly string[];
  environmentScope: readonly string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        principalId: input.principalId,
        role: input.role,
        projectId: input.projectId,
        environment: input.environment,
        directGrantIds: [...input.directGrantIds].sort(),
        delegationChain: [...input.delegationChain],
        mandateIds: [...input.mandateIds].sort(),
        mandateHashes: [...input.mandateHashes].sort(),
        revocationIds: [...input.revocationIds].sort(),
        holdIds: [...input.holdIds].sort(),
        projectScope: [...input.projectScope].sort(),
        environmentScope: [...input.environmentScope].sort(),
      }),
      "utf8",
    )
    .digest("hex");
}

export function computeSnapshotHash(
  input: Omit<InstitutionalAuthoritySnapshot, "snapshotHash" | "authoritySnapshotId">,
): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function mintAuthoritySnapshotId(snapshotHash: string): string {
  return `ias_${snapshotHash.slice(0, 24)}`;
}

export function buildAuthoritySnapshot(
  input: Omit<
    InstitutionalAuthoritySnapshot,
    "authoritySnapshotId" | "snapshotHash"
  >,
): InstitutionalAuthoritySnapshot {
  const snapshotHash = computeSnapshotHash(input);
  return InstitutionalAuthoritySnapshotSchema.parse({
    ...input,
    authoritySnapshotId: mintAuthoritySnapshotId(snapshotHash),
    snapshotHash,
  });
}
