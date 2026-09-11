import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const QUALIFICATION_EVIDENCE_KINDS = [
  "PHASE23_CERTIFICATE_REF",
  "READINESS_REPORT",
  "BUILD_MANIFEST_VERIFICATION",
  "SCHEMA_MIGRATION_STATUS",
  "GOLDEN_PATH_ACCEPTANCE",
  "RESTART_RECOVERY",
  "GRACEFUL_SHUTDOWN",
  "DATA_MINIMIZATION",
  "OBSERVABILITY",
  "BACKUP_RESTORE",
] as const;

export type QualificationEvidenceKind =
  (typeof QUALIFICATION_EVIDENCE_KINDS)[number];

export const QualificationEvidenceRecordSchema = z
  .object({
    evidenceId: z.string().min(1),
    qualificationRunId: z.string().min(1),
    evidenceKind: z.enum(QUALIFICATION_EVIDENCE_KINDS),
    referencedIdentity: z.string().min(1),
    referencedHash: z.string().min(1),
    resultCode: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
    contentHash: z.string().min(1),
    generatedAt: z.string().datetime(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type QualificationEvidenceRecord = z.infer<
  typeof QualificationEvidenceRecordSchema
>;

export function mintQualificationEvidenceId(): string {
  return `pqev_${randomUUID()}`;
}

export function computeQualificationEvidenceContentHash(
  input: Omit<QualificationEvidenceRecord, "contentHash">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        evidenceId: input.evidenceId,
        qualificationRunId: input.qualificationRunId,
        evidenceKind: input.evidenceKind,
        referencedIdentity: input.referencedIdentity,
        referencedHash: input.referencedHash,
        resultCode: input.resultCode,
        generatedAt: input.generatedAt,
        metadata: input.metadata ?? {},
      }),
      "utf8",
    )
    .digest("hex");
}

export function withQualificationEvidenceHash(
  input: Omit<QualificationEvidenceRecord, "contentHash"> & {
    contentHash?: string;
  },
): QualificationEvidenceRecord {
  const contentHash =
    input.contentHash ?? computeQualificationEvidenceContentHash(input);
  return QualificationEvidenceRecordSchema.parse({
    ...input,
    metadata: input.metadata ?? {},
    contentHash,
  });
}

export function computeQualificationEvidenceSetFingerprint(
  evidence: readonly Pick<
    QualificationEvidenceRecord,
    "evidenceId" | "contentHash"
  >[],
): string {
  const sorted = [...evidence]
    .map((e) => ({ evidenceId: e.evidenceId, contentHash: e.contentHash }))
    .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
  return createHash("sha256")
    .update(JSON.stringify({ evidence: sorted }), "utf8")
    .digest("hex");
}
