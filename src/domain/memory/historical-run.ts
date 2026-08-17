import { z } from "zod";
import { PlanVersionSchema } from "../plan/execution-plan.js";

/**
 * Historical outcome classification for learning.
 * Distinct from live OutcomeVerdict — includes governance terminal outcomes.
 */
export const HistoricalOutcomeSchema = z.enum([
  "VERIFIED_SUCCESS",
  "PARTIAL_SUCCESS",
  "VERIFICATION_FAILED",
  "INCONCLUSIVE",
  "CONTAINED",
  "BLOCKED",
  "REJECTED",
  "EXPIRED",
  "ESCALATED",
]);
export type HistoricalOutcome = z.infer<typeof HistoricalOutcomeSchema>;

/**
 * Terminal run states eligible for learning extraction.
 * Active planning/validation/execution runs are never learned as outcomes.
 */
export const LEARNABLE_TERMINAL_RUN_STATES = [
  "COMPLETED",
  "BLOCKED",
  "REJECTED",
  "EXPIRED",
  "ESCALATED",
  "CONTAINED",
] as const;

export type LearnableTerminalRunState =
  (typeof LEARNABLE_TERMINAL_RUN_STATES)[number];

export function isLearnableTerminalRunState(
  state: string,
): state is LearnableTerminalRunState {
  return (LEARNABLE_TERMINAL_RUN_STATES as readonly string[]).includes(state);
}

/**
 * Immutable provenance anchor for a terminal historical run.
 * Indexes Phase 0–8 authority outputs; is not a second source of truth.
 */
export const HistoricalRunRecordSchema = z
  .object({
    historicalRunRecordId: z.string().min(1),
    runId: z.string().min(1),
    projectId: z.string().min(1),
    objectiveId: z.string().min(1),
    objectiveVersion: z.number().int().positive(),
    objectiveFingerprint: z.string().min(1),
    planId: z.string().min(1).optional(),
    planVersion: PlanVersionSchema.optional(),
    planHash: z.string().min(1).optional(),
    validationDecisionId: z.string().min(1).optional(),
    authorizationRecordId: z.string().min(1).optional(),
    executionAttemptId: z.string().min(1).optional(),
    outcomeVerificationId: z.string().min(1).optional(),
    completionRecordId: z.string().min(1).optional(),
    outcome: HistoricalOutcomeSchema,
    runState: z.string().min(1),
    repositoryFingerprint: z.string().min(1).optional(),
    policyBundleHash: z.string().min(1).optional(),
    capabilitySetFingerprint: z.string().min(1).optional(),
    environment: z.string().min(1).optional(),
    actionTypes: z.array(z.string()).default([]),
    capabilityIds: z.array(z.string()).default([]),
    startedAt: z.string().datetime().optional(),
    finishedAt: z.string().datetime().optional(),
    recordHash: z.string().min(1),
  })
  .strict();

export type HistoricalRunRecord = z.infer<typeof HistoricalRunRecordSchema>;

export function parseHistoricalRunRecord(input: unknown): HistoricalRunRecord {
  return HistoricalRunRecordSchema.parse(input);
}
