import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const QUALIFICATION_RUN_STATUSES = [
  "CREATED",
  "EVALUATING",
  "QUALIFIED",
  "NOT_QUALIFIED",
  "INCONCLUSIVE",
] as const;

export type QualificationRunStatus =
  (typeof QUALIFICATION_RUN_STATUSES)[number];

export const ProductionQualificationRunSchema = z
  .object({
    qualificationRunId: z.string().min(1),
    releaseCandidateFingerprint: z.string().min(1),
    runtimeManifestHash: z.string().min(1),
    phase23CertificateId: z.string().min(1),
    phase23CertificateHash: z.string().min(1),
    readinessEvidenceSetFingerprint: z.string().min(1).optional(),
    systemEvidenceSetFingerprint: z.string().min(1).optional(),
    status: z.enum(QUALIFICATION_RUN_STATUSES),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    finalRecordId: z.string().min(1).optional(),
    finalRecordHash: z.string().min(1).optional(),
    recordRevision: z.number().int().positive(),
  })
  .strict();

export type ProductionQualificationRun = z.infer<
  typeof ProductionQualificationRunSchema
>;

export function mintQualificationRunId(): string {
  return `pqrun_${randomUUID()}`;
}

export function computeQualificationRunIdentityHash(
  run: Pick<
    ProductionQualificationRun,
    | "qualificationRunId"
    | "releaseCandidateFingerprint"
    | "runtimeManifestHash"
    | "phase23CertificateId"
    | "phase23CertificateHash"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        qualificationRunId: run.qualificationRunId,
        releaseCandidateFingerprint: run.releaseCandidateFingerprint,
        runtimeManifestHash: run.runtimeManifestHash,
        phase23CertificateId: run.phase23CertificateId,
        phase23CertificateHash: run.phase23CertificateHash,
      }),
      "utf8",
    )
    .digest("hex");
}
