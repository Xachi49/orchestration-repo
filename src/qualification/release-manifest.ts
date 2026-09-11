import { createHash } from "node:crypto";
import { z } from "zod";
import { RELEASE_MANIFEST_FORMAT_VERSION } from "./doctrine.js";
import type { ReleaseQualificationRecord } from "./qualification-record.js";
import type { ReleaseCandidateIdentity } from "./release-candidate.js";

export const ReleaseManifestSchema = z
  .object({
    formatVersion: z.literal(RELEASE_MANIFEST_FORMAT_VERSION),
    releaseCandidateFingerprint: z.string().min(1),
    commitSha: z.string().min(1),
    buildArtifactFingerprint: z.string().min(1),
    supportedSchemaVersion: z.string().min(1),
    migrationSetFingerprint: z.string().min(1),
    referenceRuntimeManifestHash: z.string().min(1),
    phase23CertificateId: z.string().min(1),
    phase23CertificateHash: z.string().min(1),
    releaseQualificationRecordId: z.string().min(1),
    releaseQualificationRecordHash: z.string().min(1),
    runtimeVersion: z.string().min(1),
    manifestFingerprint: z.string().min(1),
  })
  .strict();

export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

export function computeReleaseManifestFingerprint(
  input: Omit<ReleaseManifest, "manifestFingerprint">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        formatVersion: input.formatVersion,
        releaseCandidateFingerprint: input.releaseCandidateFingerprint,
        commitSha: input.commitSha,
        buildArtifactFingerprint: input.buildArtifactFingerprint,
        supportedSchemaVersion: input.supportedSchemaVersion,
        migrationSetFingerprint: input.migrationSetFingerprint,
        referenceRuntimeManifestHash: input.referenceRuntimeManifestHash,
        phase23CertificateId: input.phase23CertificateId,
        phase23CertificateHash: input.phase23CertificateHash,
        releaseQualificationRecordId: input.releaseQualificationRecordId,
        releaseQualificationRecordHash: input.releaseQualificationRecordHash,
        runtimeVersion: input.runtimeVersion,
      }),
      "utf8",
    )
    .digest("hex");
}

export function buildReleaseManifest(input: {
  candidate: ReleaseCandidateIdentity;
  releaseCandidateFingerprint: string;
  record: ReleaseQualificationRecord;
}): ReleaseManifest {
  const base = {
    formatVersion: RELEASE_MANIFEST_FORMAT_VERSION,
    releaseCandidateFingerprint: input.releaseCandidateFingerprint,
    commitSha: input.candidate.commitSha,
    buildArtifactFingerprint: input.candidate.buildArtifactFingerprint,
    supportedSchemaVersion: input.candidate.supportedSchemaVersion,
    migrationSetFingerprint: input.candidate.migrationSetFingerprint,
    referenceRuntimeManifestHash: input.candidate.referenceRuntimeManifestHash,
    phase23CertificateId: input.record.phase23CertificateId,
    phase23CertificateHash: input.record.phase23CertificateHash,
    releaseQualificationRecordId: input.record.recordId,
    releaseQualificationRecordHash: input.record.recordHash,
    runtimeVersion: input.candidate.runtimeVersion,
  } as const;
  return ReleaseManifestSchema.parse({
    ...base,
    manifestFingerprint: computeReleaseManifestFingerprint(base),
  });
}

/** Exportable bundle metadata — not a deployment action. */
export const ReleaseBundleSchema = z
  .object({
    releaseManifest: ReleaseManifestSchema,
    qualificationRecordId: z.string().min(1),
    qualificationRecordHash: z.string().min(1),
    /** Explicit non-deployment marker. */
    deploymentAuthorized: z.literal(false),
  })
  .strict();

export type ReleaseBundle = z.infer<typeof ReleaseBundleSchema>;

export function buildReleaseBundle(
  manifest: ReleaseManifest,
  record: ReleaseQualificationRecord,
): ReleaseBundle {
  return ReleaseBundleSchema.parse({
    releaseManifest: manifest,
    qualificationRecordId: record.recordId,
    qualificationRecordHash: record.recordHash,
    deploymentAuthorized: false,
  });
}
