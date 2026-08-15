import { z } from "zod";

export const TrustLevelSchema = z.enum([
  "SYSTEM_AUTHORITY",
  "POLICY_AUTHORITY",
  "REMOTE_VERIFIED",
  "LOCAL_VERIFIED",
  "USER_PROVIDED",
  "HISTORICAL_PRECEDENT",
  "UNTRUSTED_EXTERNAL",
  "UNKNOWN",
]);

export type TrustLevel = z.infer<typeof TrustLevelSchema>;

export const EvidenceRecordSchema = z
  .object({
    evidenceId: z.string().min(1),
    sourceType: z.string().min(1),
    sourcePath: z.string().min(1).optional(),
    sourceIdentifier: z.string().min(1).optional(),
    contentHash: z.string().min(1),
    trustLevel: TrustLevelSchema,
    observedAt: z.string().datetime(),
    summary: z.string().min(1),
    runId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    commitSha: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.sourcePath && !value.sourceIdentifier) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "EvidenceRecord requires sourcePath or sourceIdentifier",
        path: ["sourcePath"],
      });
    }
  });

export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export function parseEvidenceRecord(input: unknown): EvidenceRecord {
  return EvidenceRecordSchema.parse(input);
}
