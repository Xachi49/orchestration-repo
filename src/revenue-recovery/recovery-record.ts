import { z } from "zod";
import { hashCanonical } from "./hash.js";
import { RECOVERY_OUTCOMES } from "./recovery-outcome.js";
import { TRUST_PROVENANCE_CLASSES } from "./provenance.js";
import { ATTRIBUTION_CONFIDENCE } from "./revenue-attribution.js";

export const RecoveryRecordAttributionLineageSchema = z
  .object({
    attributionId: z.string().min(1),
    sourceEventId: z.string().min(1),
    sourceIdentity: z.string().min(1),
    trustProvenance: z.enum(TRUST_PROVENANCE_CLASSES),
    confidenceClass: z.enum(ATTRIBUTION_CONFIDENCE),
    attributionType: z.string().min(1),
    amount: z.number().nonnegative().finite(),
    attributionRuleVersion: z.string().min(1),
  })
  .strict();

export const RevenueRecoveryRecordSchema = z
  .object({
    recoveryRecordId: z.string().min(1),
    recoveryCaseId: z.string().min(1),
    leadId: z.string().min(1),
    customerAccountId: z.string().min(1),
    projectId: z.string().min(1),
    orchestratorRunId: z.string().min(1).optional(),
    completionRecordId: z.string().min(1).optional(),
    initialGapDetectedAt: z.string().datetime(),
    outreachAttemptIds: z.array(z.string().min(1)),
    engagementEventId: z.string().min(1).optional(),
    appointmentEventId: z.string().min(1).optional(),
    saleAttributionId: z.string().min(1).optional(),
    paymentAttributionId: z.string().min(1).optional(),
    estimatedRecoverableValue: z.number().nonnegative().finite().optional(),
    bookedRecoveredRevenue: z.number().nonnegative().finite().optional(),
    confirmedCollectedRevenue: z.number().nonnegative().finite().optional(),
    operatorAttestedRevenue: z.number().nonnegative().finite().optional(),
    attributionLineage: z.array(RecoveryRecordAttributionLineageSchema),
    currency: z.string().length(3),
    outcome: z.enum(RECOVERY_OUTCOMES),
    evidenceRefs: z.array(z.string().min(1)),
    createdAt: z.string().datetime(),
    recordHash: z.string().min(1),
  })
  .strict();

export type RevenueRecoveryRecord = z.infer<typeof RevenueRecoveryRecordSchema>;

export function parseRevenueRecoveryRecord(
  input: unknown,
): RevenueRecoveryRecord {
  return RevenueRecoveryRecordSchema.parse(input);
}

export function computeRecoveryRecordHash(
  record: Omit<RevenueRecoveryRecord, "recordHash">,
): string {
  return hashCanonical(record);
}

export function newRecoveryRecordId(recoveryCaseId: string): string {
  return `rrec_${hashCanonical(recoveryCaseId).slice(0, 24)}`;
}
