import { z } from "zod";

export const IngestionFenceStatusSchema = z.enum([
  "NOT_STARTED",
  "IN_PROGRESS",
  "VERIFIED",
  "FAILED",
]);
export type IngestionFenceStatus = z.infer<typeof IngestionFenceStatusSchema>;

export const IngestionFenceSchema = z
  .object({
    runId: z.string().min(1),
    status: IngestionFenceStatusSchema,
    attempt: z.number().int().nonnegative(),
    lastUpdatedAt: z.string().datetime(),
    ownerToken: z.string().min(1).optional(),
    failureCode: z.string().min(1).optional(),
    failedAt: z.string().datetime().optional(),
    retryable: z.boolean().optional(),
    verifiedAt: z.string().datetime().optional(),
  })
  .strict();
export type IngestionFence = z.infer<typeof IngestionFenceSchema>;

export type BeginIngestionResult =
  | {
      outcome: "STARTED";
      fence: IngestionFence;
      ownerToken: string;
    }
  | {
      outcome: "ALREADY_VERIFIED";
      fence: IngestionFence;
    };

/**
 * Per-run ingestion fencing.
 *
 * In-memory adapters are not distributed. Durable implementations must use
 * atomic compare-and-set / unique run fencing for begin / verify / fail.
 */
export interface RepositoryIngestionCoordinator {
  get(runId: string): Promise<IngestionFence | null>;
  /**
   * Atomic transitions:
   * - missing/NOT_STARTED → IN_PROGRESS (attempt 1)
   * - FAILED → IN_PROGRESS (attempt + 1) when retryable
   * - VERIFIED → ALREADY_VERIFIED
   * - IN_PROGRESS → throws INGESTION_IN_PROGRESS
   */
  begin(runId: string, nowIso: string): Promise<BeginIngestionResult>;
  markVerified(
    runId: string,
    ownerToken: string,
    nowIso: string,
  ): Promise<IngestionFence>;
  markFailed(
    runId: string,
    ownerToken: string,
    failure: {
      failureCode: string;
      failedAt: string;
      retryable: boolean;
    },
  ): Promise<IngestionFence>;
  /**
   * Crash recovery: promote fence to VERIFIED when a complete context already
   * exists but the fence was never updated.
   */
  reconcileVerified(runId: string, nowIso: string): Promise<IngestionFence>;
}
