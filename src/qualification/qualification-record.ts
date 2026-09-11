import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { QualificationError } from "./errors.js";

export const RELEASE_QUALIFICATION_OUTCOMES = [
  "QUALIFIED_FOR_RELEASE",
  "NOT_QUALIFIED",
  "INCONCLUSIVE",
] as const;

export type ReleaseQualificationOutcome =
  (typeof RELEASE_QUALIFICATION_OUTCOMES)[number];

export const CURRENT_RELEASE_APPLICABILITY = [
  "APPLICABLE",
  "STALE",
  "EXPIRED",
  "INVALID",
] as const;

export type CurrentReleaseApplicability =
  (typeof CURRENT_RELEASE_APPLICABILITY)[number];

export const ReleaseQualificationRecordSchema = z
  .object({
    recordId: z.string().min(1),
    recordVersion: z.number().int().positive(),
    recordHash: z.string().min(1),
    qualificationRunId: z.string().min(1),
    releaseCandidateFingerprint: z.string().min(1),
    buildArtifactFingerprint: z.string().min(1),
    referenceRuntimeManifestHash: z.string().min(1),
    phase23CertificateId: z.string().min(1),
    phase23CertificateHash: z.string().min(1),
    phase23TargetFingerprint: z.string().min(1),
    readinessEvidenceSetFingerprint: z.string().min(1),
    systemQualificationEvidenceSetFingerprint: z.string().min(1),
    evaluatedAt: z.string().datetime(),
    validUntil: z.string().datetime().optional(),
    outcome: z.enum(RELEASE_QUALIFICATION_OUTCOMES),
  })
  .strict();

export type ReleaseQualificationRecord = z.infer<
  typeof ReleaseQualificationRecordSchema
>;

export function mintReleaseQualificationRecordId(
  materialFingerprint: string,
): string {
  return `rqr_${materialFingerprint.slice(0, 24)}`;
}

export function mintReleaseQualificationIdentity(): string {
  return `rqr_${randomUUID()}`;
}

export function computeReleaseQualificationMaterialFingerprint(input: {
  qualificationRunId: string;
  releaseCandidateFingerprint: string;
  buildArtifactFingerprint: string;
  referenceRuntimeManifestHash: string;
  phase23CertificateId: string;
  phase23CertificateHash: string;
  readinessEvidenceSetFingerprint: string;
  systemQualificationEvidenceSetFingerprint: string;
  outcome: ReleaseQualificationOutcome;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        qualificationRunId: input.qualificationRunId,
        releaseCandidateFingerprint: input.releaseCandidateFingerprint,
        buildArtifactFingerprint: input.buildArtifactFingerprint,
        referenceRuntimeManifestHash: input.referenceRuntimeManifestHash,
        phase23CertificateId: input.phase23CertificateId,
        phase23CertificateHash: input.phase23CertificateHash,
        readinessEvidenceSetFingerprint: input.readinessEvidenceSetFingerprint,
        systemQualificationEvidenceSetFingerprint:
          input.systemQualificationEvidenceSetFingerprint,
        outcome: input.outcome,
      }),
      "utf8",
    )
    .digest("hex");
}

export function computeReleaseQualificationRecordHash(
  input: Omit<ReleaseQualificationRecord, "recordHash">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        recordId: input.recordId,
        recordVersion: input.recordVersion,
        qualificationRunId: input.qualificationRunId,
        releaseCandidateFingerprint: input.releaseCandidateFingerprint,
        buildArtifactFingerprint: input.buildArtifactFingerprint,
        referenceRuntimeManifestHash: input.referenceRuntimeManifestHash,
        phase23CertificateId: input.phase23CertificateId,
        phase23CertificateHash: input.phase23CertificateHash,
        phase23TargetFingerprint: input.phase23TargetFingerprint,
        readinessEvidenceSetFingerprint: input.readinessEvidenceSetFingerprint,
        systemQualificationEvidenceSetFingerprint:
          input.systemQualificationEvidenceSetFingerprint,
        evaluatedAt: input.evaluatedAt,
        ...(input.validUntil !== undefined
          ? { validUntil: input.validUntil }
          : {}),
        outcome: input.outcome,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withReleaseQualificationRecordHash(
  input: Omit<ReleaseQualificationRecord, "recordHash">,
): ReleaseQualificationRecord {
  return ReleaseQualificationRecordSchema.parse({
    ...input,
    recordHash: computeReleaseQualificationRecordHash(input),
  });
}

/**
 * Derived current applicability — never mutates historical Q1.
 */
export function evaluateCurrentReleaseApplicability(input: {
  record: ReleaseQualificationRecord;
  currentReleaseCandidateFingerprint: string;
  currentRuntimeManifestHash: string;
  currentBuildArtifactFingerprint: string;
  phase23CertificateCurrentlyValid: boolean;
  evidenceIntegrityValid: boolean;
  atIso: string;
}): CurrentReleaseApplicability {
  const r = input.record;
  if (r.outcome !== "QUALIFIED_FOR_RELEASE") {
    return "INVALID";
  }
  if (!input.evidenceIntegrityValid) {
    return "INVALID";
  }
  if (!input.phase23CertificateCurrentlyValid) {
    return "STALE";
  }
  if (
    r.releaseCandidateFingerprint !==
      input.currentReleaseCandidateFingerprint ||
    r.referenceRuntimeManifestHash !== input.currentRuntimeManifestHash ||
    r.buildArtifactFingerprint !== input.currentBuildArtifactFingerprint
  ) {
    return "STALE";
  }
  if (
    r.validUntil !== undefined &&
    Date.parse(input.atIso) > Date.parse(r.validUntil)
  ) {
    return "EXPIRED";
  }
  return "APPLICABLE";
}

export function assertNoDeploymentFields(
  record: ReleaseQualificationRecord,
): void {
  const json = JSON.stringify(record);
  if (
    json.includes("DEPLOYED") ||
    json.includes("deploymentUrl") ||
    json.includes("deployedAt")
  ) {
    throw new QualificationError(
      "RELEASE_MANIFEST_INVALID",
      "Release qualification record must not claim deployment",
    );
  }
}
