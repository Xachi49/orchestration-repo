import { createHash } from "node:crypto";
import { z } from "zod";
import { QualificationError } from "./errors.js";

/**
 * Immutable identity of the exact candidate under qualification.
 * Secrets, clocks, PIDs, host paths, and ephemeral ports are excluded.
 *
 * Identity dependency direction (acyclic):
 *
 *   build/config/runtime material
 *     → AssuranceTargetFingerprint T
 *     → Phase23 certificate C(T)
 *
 *   release candidate binds T + build/runtime material
 *     → ReleaseCandidateFingerprint RC
 *
 *   qualification binds RC + C(T)
 *
 * T must NOT depend on RC. RC may include T.
 */
export const ReleaseCandidateIdentitySchema = z
  .object({
    repositoryIdentity: z.string().min(1),
    commitSha: z.string().min(1),
    repositoryFingerprint: z.string().min(1),
    packageLockHash: z.string().min(1),
    buildArtifactFingerprint: z.string().min(1),
    migrationSetFingerprint: z.string().min(1),
    supportedSchemaVersion: z.string().min(1),
    runtimeVersion: z.string().min(1),
    productionConfigurationProfileFingerprint: z.string().min(1),
    referenceRuntimeManifestHash: z.string().min(1),
    /** Must equal Phase23 AssuranceTarget fingerprint for the final target. */
    assuranceTargetFingerprint: z.string().min(1),
    controlCatalogFingerprint: z.string().min(1),
  })
  .strict();

export type ReleaseCandidateIdentity = z.infer<
  typeof ReleaseCandidateIdentitySchema
>;

export function canonicalizeReleaseCandidate(
  input: ReleaseCandidateIdentity,
): ReleaseCandidateIdentity {
  return ReleaseCandidateIdentitySchema.parse(input);
}

export function computeReleaseCandidateFingerprint(
  input: ReleaseCandidateIdentity,
): string {
  const c = canonicalizeReleaseCandidate(input);
  return createHash("sha256")
    .update(
      JSON.stringify({
        repositoryIdentity: c.repositoryIdentity,
        commitSha: c.commitSha,
        repositoryFingerprint: c.repositoryFingerprint,
        packageLockHash: c.packageLockHash,
        buildArtifactFingerprint: c.buildArtifactFingerprint,
        migrationSetFingerprint: c.migrationSetFingerprint,
        supportedSchemaVersion: c.supportedSchemaVersion,
        runtimeVersion: c.runtimeVersion,
        productionConfigurationProfileFingerprint:
          c.productionConfigurationProfileFingerprint,
        referenceRuntimeManifestHash: c.referenceRuntimeManifestHash,
        assuranceTargetFingerprint: c.assuranceTargetFingerprint,
        controlCatalogFingerprint: c.controlCatalogFingerprint,
      }),
      "utf8",
    )
    .digest("hex");
}

export function assertReleaseCandidateMatchesAssuranceTarget(
  candidate: ReleaseCandidateIdentity,
  certificateTargetFingerprint: string,
): void {
  if (candidate.assuranceTargetFingerprint !== certificateTargetFingerprint) {
    throw new QualificationError(
      "PHASE23_TARGET_MISMATCH",
      "Release candidate assurance target fingerprint does not match certificate target",
      {
        candidate: candidate.assuranceTargetFingerprint,
        certificate: certificateTargetFingerprint,
      },
    );
  }
}
