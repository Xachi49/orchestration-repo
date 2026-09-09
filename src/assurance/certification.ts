import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AssuranceError } from "./errors.js";

/**
 * Issuance status is fixed at write time as VALID (= issued successfully).
 * It is NEVER rewritten after issuance. Current usability is derived by
 * evaluateCertificateCurrentValidity via revocation overlays, validUntil,
 * and exact target fingerprint match — not by mutating this field.
 */
export const SYSTEM_CERTIFICATE_ISSUANCE_STATUS = ["VALID"] as const;

export type SystemCertificateIssuanceStatus =
  (typeof SYSTEM_CERTIFICATE_ISSUANCE_STATUS)[number];

export const CURRENT_CERTIFICATE_VALIDATION_RESULTS = [
  "VALID",
  "EXPIRED",
  "REVOKED",
  "STALE",
] as const;

export type CurrentCertificateValidationResult =
  (typeof CURRENT_CERTIFICATE_VALIDATION_RESULTS)[number];

export const SystemCertificateSchema = z
  .object({
    certificateId: z.string().min(1),
    certificateVersion: z.number().int().positive(),
    certificateHash: z.string().min(1),
    certificationMaterialFingerprint: z.string().min(1),
    targetFingerprint: z.string().min(1),
    profileId: z.string().min(1),
    profileVersion: z.number().int().positive(),
    profileHash: z.string().min(1),
    assuranceRunId: z.string().min(1),
    assessmentId: z.string().min(1),
    assessmentHash: z.string().min(1),
    controlCatalogFingerprint: z.string().min(1),
    evidenceSetFingerprint: z.string().min(1),
    certifierPrincipalId: z.string().min(1),
    institutionalAuthorizationProofId: z.string().min(1),
    proofHash: z.string().min(1),
    issuedAt: z.string().datetime(),
    validUntil: z.string().datetime(),
    /** Issuance marker only — never mutated after issue. */
    status: z.enum(SYSTEM_CERTIFICATE_ISSUANCE_STATUS),
    recordRevision: z.number().int().positive(),
  })
  .strict();

export type SystemCertificate = z.infer<typeof SystemCertificateSchema>;

export function computeCertificationMaterialFingerprint(input: {
  targetFingerprint: string;
  profileId: string;
  profileVersion: number;
  profileHash: string;
  assessmentId: string;
  assessmentHash: string;
  evidenceSetFingerprint: string;
  controlCatalogFingerprint: string;
  proofId: string;
  proofHash: string;
  validitySeconds: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        targetFingerprint: input.targetFingerprint,
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        profileHash: input.profileHash,
        assessmentId: input.assessmentId,
        assessmentHash: input.assessmentHash,
        evidenceSetFingerprint: input.evidenceSetFingerprint,
        controlCatalogFingerprint: input.controlCatalogFingerprint,
        proofId: input.proofId,
        proofHash: input.proofHash,
        validitySeconds: input.validitySeconds,
      }),
      "utf8",
    )
    .digest("hex");
}

export function computeCertificateHash(
  input: Omit<SystemCertificate, "certificateHash">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        certificateId: input.certificateId,
        certificateVersion: input.certificateVersion,
        certificationMaterialFingerprint:
          input.certificationMaterialFingerprint,
        targetFingerprint: input.targetFingerprint,
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        profileHash: input.profileHash,
        assuranceRunId: input.assuranceRunId,
        assessmentId: input.assessmentId,
        assessmentHash: input.assessmentHash,
        controlCatalogFingerprint: input.controlCatalogFingerprint,
        evidenceSetFingerprint: input.evidenceSetFingerprint,
        certifierPrincipalId: input.certifierPrincipalId,
        institutionalAuthorizationProofId:
          input.institutionalAuthorizationProofId,
        proofHash: input.proofHash,
        issuedAt: input.issuedAt,
        validUntil: input.validUntil,
        status: input.status,
        recordRevision: input.recordRevision,
      }),
      "utf8",
    )
    .digest("hex");
}

export function mintCertificateId(materialFingerprint: string): string {
  return `acert_${materialFingerprint.slice(0, 24)}`;
}

export function withCertificateHash(
  input: Omit<SystemCertificate, "certificateHash">,
): SystemCertificate {
  return SystemCertificateSchema.parse({
    ...input,
    certificateHash: computeCertificateHash(input),
  });
}

export function mintCertificateIdentity(): string {
  return `acert_${randomUUID()}`;
}

export function evaluateCertificateCurrentValidity(input: {
  certificate: SystemCertificate;
  currentTargetFingerprint: string;
  atIso: string;
  revoked: boolean;
}): CurrentCertificateValidationResult {
  const c = input.certificate;
  if (input.revoked) {
    return "REVOKED";
  }
  if (c.targetFingerprint !== input.currentTargetFingerprint) {
    return "STALE";
  }
  if (Date.parse(input.atIso) > Date.parse(c.validUntil)) {
    return "EXPIRED";
  }
  return "VALID";
}

export function assertCertificateCurrentlyValid(input: {
  certificate: SystemCertificate;
  currentTargetFingerprint: string;
  atIso: string;
  revoked: boolean;
}): void {
  const result = evaluateCertificateCurrentValidity(input);
  if (result === "VALID") return;
  if (result === "REVOKED") {
    throw new AssuranceError(
      "ASSURANCE_CERTIFICATE_REVOKED",
      `Certificate ${input.certificate.certificateId} is revoked`,
    );
  }
  if (result === "EXPIRED") {
    throw new AssuranceError(
      "ASSURANCE_CERTIFICATE_EXPIRED",
      `Certificate ${input.certificate.certificateId} expired`,
    );
  }
  throw new AssuranceError(
    "ASSURANCE_TARGET_DRIFT",
    "Certificate target fingerprint does not match current target",
    {
      certified: input.certificate.targetFingerprint,
      current: input.currentTargetFingerprint,
      currentValidity: "STALE",
    },
  );
}
