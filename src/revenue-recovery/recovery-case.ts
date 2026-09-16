import { z } from "zod";
import { hashCanonical } from "./hash.js";

export const RECOVERY_CASE_STATUSES = [
  "OPEN",
  "ANALYZING",
  "READY_FOR_ORCHESTRATION",
  "IN_ORCHESTRATION",
  "ENGAGED",
  "APPOINTMENT_BOOKED",
  "CONVERTED",
  "CLOSED_UNRECOVERED",
  "SUPPRESSED",
] as const;

export type RecoveryCaseStatus = (typeof RECOVERY_CASE_STATUSES)[number];

export const RecoveryCaseSchema = z
  .object({
    recoveryCaseId: z.string().min(1),
    gapIdentityKey: z.string().min(1),
    leadId: z.string().min(1),
    customerAccountId: z.string().min(1),
    projectId: z.string().min(1),
    gapDetectedAt: z.string().datetime(),
    reasonCode: z.string().min(1),
    estimatedRecoverableValue: z.number().nonnegative().finite().optional(),
    currency: z.string().length(3).optional(),
    status: z.enum(RECOVERY_CASE_STATUSES),
    configId: z.string().min(1),
    configVersion: z.number().int().positive(),
    configFingerprint: z.string().min(1),
    recoveryObjectiveVersion: z.number().int().positive().optional(),
    orchestratorRunId: z.string().min(1).optional(),
    objectiveId: z.string().min(1).optional(),
    suppressionReason: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    recordRevision: z.number().int().positive(),
  })
  .strict();

export type RecoveryCase = z.infer<typeof RecoveryCaseSchema>;

export function parseRecoveryCase(input: unknown): RecoveryCase {
  return RecoveryCaseSchema.parse(input);
}

export function newRecoveryCaseId(gapIdentityKey: string): string {
  return `rcase_${hashCanonical(gapIdentityKey).slice(0, 24)}`;
}

export const ACTIVE_RECOVERY_CASE_STATUSES: readonly RecoveryCaseStatus[] = [
  "OPEN",
  "ANALYZING",
  "READY_FOR_ORCHESTRATION",
  "IN_ORCHESTRATION",
  "ENGAGED",
  "APPOINTMENT_BOOKED",
];
