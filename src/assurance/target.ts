import { createHash } from "node:crypto";
import { z } from "zod";
import { AssuranceError } from "./errors.js";

export const AssuranceTargetIdentitySchema = z
  .object({
    repositoryCommitSha: z.string().min(1),
    repositoryFingerprint: z.string().min(1),
    buildArtifactHash: z.string().min(1),
    packageLockHash: z.string().min(1),
    migrationSetFingerprint: z.string().min(1),
    supportedSchemaVersion: z.string().min(1),
    runtimeVersion: z.string().min(1),
    controlCatalogVersion: z.string().min(1),
    controlCatalogHash: z.string().min(1),
    configurationProfileFingerprint: z.string().min(1),
    featureFlagsFingerprint: z.string().min(1),
    assuranceProfileId: z.string().min(1),
    assuranceProfileVersion: z.number().int().positive(),
    assuranceProfileHash: z.string().min(1),
  })
  .strict();

export type AssuranceTargetIdentity = z.infer<
  typeof AssuranceTargetIdentitySchema
>;

export function canonicalizeTargetIdentity(
  input: AssuranceTargetIdentity,
): AssuranceTargetIdentity {
  return AssuranceTargetIdentitySchema.parse(input);
}

export function computeTargetFingerprint(
  input: AssuranceTargetIdentity,
): string {
  const canonical = canonicalizeTargetIdentity(input);
  return createHash("sha256")
    .update(
      JSON.stringify({
        repositoryCommitSha: canonical.repositoryCommitSha,
        repositoryFingerprint: canonical.repositoryFingerprint,
        buildArtifactHash: canonical.buildArtifactHash,
        packageLockHash: canonical.packageLockHash,
        migrationSetFingerprint: canonical.migrationSetFingerprint,
        supportedSchemaVersion: canonical.supportedSchemaVersion,
        runtimeVersion: canonical.runtimeVersion,
        controlCatalogVersion: canonical.controlCatalogVersion,
        controlCatalogHash: canonical.controlCatalogHash,
        configurationProfileFingerprint:
          canonical.configurationProfileFingerprint,
        featureFlagsFingerprint: canonical.featureFlagsFingerprint,
        assuranceProfileId: canonical.assuranceProfileId,
        assuranceProfileVersion: canonical.assuranceProfileVersion,
        assuranceProfileHash: canonical.assuranceProfileHash,
      }),
      "utf8",
    )
    .digest("hex");
}

export function assertTargetMatches(
  expectedFingerprint: string,
  identity: AssuranceTargetIdentity,
): void {
  const current = computeTargetFingerprint(identity);
  if (current !== expectedFingerprint) {
    throw new AssuranceError(
      "ASSURANCE_TARGET_DRIFT",
      "Assurance target fingerprint mismatch — certificate/run bound to different target",
      { expected: expectedFingerprint, current },
    );
  }
}
