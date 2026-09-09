import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ASSURANCE_EVIDENCE_KINDS } from "./control.js";
import { AssuranceError } from "./errors.js";

export const ASSURANCE_EVIDENCE_QUALITY = [
  "DIRECT",
  "REPRODUCED",
  "PARTIAL",
  "UNKNOWN",
] as const;

export type AssuranceEvidenceQuality =
  (typeof ASSURANCE_EVIDENCE_QUALITY)[number];

export const AssuranceEvidenceRecordSchema = z
  .object({
    evidenceId: z.string().min(1),
    evidenceKind: z.enum(ASSURANCE_EVIDENCE_KINDS),
    assuranceRunId: z.string().min(1),
    challengeId: z.string().min(1),
    challengeVersion: z.string().min(1),
    controlIds: z.array(z.string().min(1)).min(1),
    targetFingerprint: z.string().min(1),
    sourceIdentity: z.string().min(1),
    contentHash: z.string().min(1),
    generatedAt: z.string().datetime(),
    evidenceQuality: z.enum(ASSURANCE_EVIDENCE_QUALITY),
    resultCode: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type AssuranceEvidenceRecord = z.infer<
  typeof AssuranceEvidenceRecordSchema
>;

const FORBIDDEN_METADATA_KEYS = [
  "approvalNonce",
  "deliverySecret",
  "databasePassword",
  "bearerToken",
  "authorization",
  "chainOfThought",
  "password",
  "secret",
  "apiKey",
] as const;

export function assertEvidenceMinimized(
  metadata: Record<string, unknown>,
): void {
  for (const key of Object.keys(metadata)) {
    const lower = key.toLowerCase();
    if (
      FORBIDDEN_METADATA_KEYS.some((f) => lower.includes(f.toLowerCase())) ||
      lower.includes("nonce") ||
      lower.includes("password") ||
      lower.includes("secret") ||
      lower.includes("token") ||
      lower.includes("chainofthought")
    ) {
      throw new AssuranceError(
        "ASSURANCE_EVIDENCE_TAMPERED",
        `Evidence metadata contains forbidden key: ${key}`,
      );
    }
  }
}

/**
 * Stable deep canonicalization so JSONB key reordering (Postgres) cannot
 * change evidence content hashes. Candidate / caller targets never enter here.
 */
export function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }
  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort((a, b) => a.localeCompare(b))) {
      out[key] = canonicalizeJsonValue(input[key]);
    }
    return out;
  }
  return value;
}

export type EvidenceContentHashInput = {
  evidenceId: string;
  evidenceKind: AssuranceEvidenceRecord["evidenceKind"];
  assuranceRunId: string;
  challengeId: string;
  challengeVersion: string;
  controlIds: readonly string[];
  /** Stored evidence binding — never a validateCertificate candidate target. */
  targetFingerprint: string;
  sourceIdentity: string;
  generatedAt: string;
  evidenceQuality: AssuranceEvidenceQuality;
  resultCode: "PASS" | "FAIL" | "INCONCLUSIVE";
  metadata: Record<string, unknown>;
};

/**
 * Content hash depends ONLY on immutable stored evidence material.
 * Must be identical regardless of whether a caller later validates a
 * certificate against T1 or T2.
 */
export function computeEvidenceContentHash(
  input: EvidenceContentHashInput,
): string {
  assertEvidenceMinimized(input.metadata);
  return createHash("sha256")
    .update(
      JSON.stringify({
        evidenceId: input.evidenceId,
        evidenceKind: input.evidenceKind,
        assuranceRunId: input.assuranceRunId,
        challengeId: input.challengeId,
        challengeVersion: input.challengeVersion,
        controlIds: [...input.controlIds].sort(),
        targetFingerprint: input.targetFingerprint,
        sourceIdentity: input.sourceIdentity,
        generatedAt: input.generatedAt,
        evidenceQuality: input.evidenceQuality,
        resultCode: input.resultCode,
        metadata: canonicalizeJsonValue(input.metadata),
      }),
      "utf8",
    )
    .digest("hex");
}

/** Recompute from a stored evidence row; ignores contentHash and any caller target. */
export function recomputeEvidenceContentHash(
  evidence: AssuranceEvidenceRecord | Omit<AssuranceEvidenceRecord, "contentHash">,
): string {
  return computeEvidenceContentHash({
    evidenceId: evidence.evidenceId,
    evidenceKind: evidence.evidenceKind,
    assuranceRunId: evidence.assuranceRunId,
    challengeId: evidence.challengeId,
    challengeVersion: evidence.challengeVersion,
    controlIds: evidence.controlIds,
    targetFingerprint: evidence.targetFingerprint,
    sourceIdentity: evidence.sourceIdentity,
    generatedAt: evidence.generatedAt,
    evidenceQuality: evidence.evidenceQuality,
    resultCode: evidence.resultCode,
    metadata: evidence.metadata ?? {},
  });
}

export function mintEvidenceId(): string {
  return `aev_${randomUUID()}`;
}

export function withEvidenceHash(
  input: Omit<AssuranceEvidenceRecord, "contentHash"> & {
    contentHash?: string;
  },
): AssuranceEvidenceRecord {
  const contentHash =
    input.contentHash ?? recomputeEvidenceContentHash(input);
  return AssuranceEvidenceRecordSchema.parse({
    ...input,
    metadata: input.metadata ?? {},
    contentHash,
  });
}

export function computeEvidenceSetFingerprint(
  evidence: readonly Pick<
    AssuranceEvidenceRecord,
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

export function isAdmissibleEvidenceQuality(
  quality: AssuranceEvidenceQuality,
): boolean {
  return quality === "DIRECT" || quality === "REPRODUCED";
}
