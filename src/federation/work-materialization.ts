import { createHash } from "node:crypto";
import { z } from "zod";

export const FederatedMaterializationRecordSchema = z
  .object({
    materializationId: z.string().min(1),
    federationId: z.string().min(1),
    agreementId: z.string().min(1),
    agreementVersion: z.number().int().positive(),
    agreementHash: z.string().min(1),
    intentId: z.string().min(1),
    intentHash: z.string().min(1),
    acceptanceId: z.string().min(1),
    acceptanceHash: z.string().min(1),
    targetLocalRequesterId: z.string().min(1),
    targetInstitutionId: z.string().min(1),
    targetProjectId: z.string().min(1),
    environment: z.string().min(1),
    objectiveId: z.string().min(1),
    objectiveVersion: z.number().int().positive(),
    runId: z.string().min(1),
    materializedAt: z.string().datetime(),
    materializationHash: z.string().min(1),
  })
  .strict();

export type FederatedMaterializationRecord = z.infer<
  typeof FederatedMaterializationRecordSchema
>;

export function computeMaterializationHash(
  input: Omit<FederatedMaterializationRecord, "materializationHash">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        materializationId: input.materializationId,
        federationId: input.federationId,
        agreementId: input.agreementId,
        agreementVersion: input.agreementVersion,
        agreementHash: input.agreementHash,
        intentId: input.intentId,
        intentHash: input.intentHash,
        acceptanceId: input.acceptanceId,
        acceptanceHash: input.acceptanceHash,
        targetLocalRequesterId: input.targetLocalRequesterId,
        targetInstitutionId: input.targetInstitutionId,
        targetProjectId: input.targetProjectId,
        environment: input.environment,
        objectiveId: input.objectiveId,
        objectiveVersion: input.objectiveVersion,
        runId: input.runId,
        materializedAt: input.materializedAt,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withMaterializationHash(
  input: Omit<FederatedMaterializationRecord, "materializationHash">,
): FederatedMaterializationRecord {
  return FederatedMaterializationRecordSchema.parse({
    ...input,
    materializationHash: computeMaterializationHash(input),
  });
}

export function mintMaterializationId(input: {
  intentId: string;
  targetProjectId: string;
  environment: string;
}): string {
  return `fmat_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

/** Stable idempotency key for same accepted intent → one logical admission. */
export function materializationIdempotencyKey(input: {
  intentId: string;
  intentHash: string;
  targetProjectId: string;
  environment: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        intentId: input.intentId,
        intentHash: input.intentHash,
        targetProjectId: input.targetProjectId,
        environment: input.environment,
      }),
      "utf8",
    )
    .digest("hex");
}
