import { z } from "zod";
import { MemoryError } from "./errors.js";

export const LearningFenceStatusSchema = z.enum([
  "NOT_STARTED",
  "IN_PROGRESS",
  "PROCESSED",
  "FAILED",
]);
export type LearningFenceStatus = z.infer<typeof LearningFenceStatusSchema>;

export const LearningFenceKeySchema = z
  .object({
    runId: z.string().min(1),
    outcome: z.string().min(1),
    outcomeVerificationId: z.string().optional(),
  })
  .strict();
export type LearningFenceKey = z.infer<typeof LearningFenceKeySchema>;

export const LearningFenceSchema = z
  .object({
    fenceKey: z.string().min(1),
    runId: z.string().min(1),
    outcome: z.string().min(1),
    outcomeVerificationId: z.string().optional(),
    status: LearningFenceStatusSchema,
    attempt: z.number().int().nonnegative(),
    lastUpdatedAt: z.string().datetime(),
    ownerToken: z.string().min(1).optional(),
    failureCode: z.string().min(1).optional(),
    historicalRunRecordId: z.string().min(1).optional(),
  })
  .strict();
export type LearningFence = z.infer<typeof LearningFenceSchema>;

export function learningFenceKey(key: LearningFenceKey): string {
  const parsed = LearningFenceKeySchema.parse(key);
  return [
    parsed.runId,
    parsed.outcome,
    parsed.outcomeVerificationId ?? "",
  ].join(":");
}

export type BeginLearningResult =
  | { outcome: "STARTED"; fence: LearningFence; ownerToken: string }
  | { outcome: "ALREADY_PROCESSED"; fence: LearningFence }
  | { outcome: "IN_PROGRESS"; fence: LearningFence };

export interface LearningCoordinator {
  get(key: LearningFenceKey): Promise<LearningFence | null>;
  begin(key: LearningFenceKey, nowIso: string): Promise<BeginLearningResult>;
  markProcessed(
    key: LearningFenceKey,
    ownerToken: string,
    nowIso: string,
    historicalRunRecordId: string,
  ): Promise<LearningFence>;
  markFailed(
    key: LearningFenceKey,
    ownerToken: string,
    nowIso: string,
    failureCode: string,
  ): Promise<LearningFence>;
}

/**
 * Process-local learning fence by terminal run/outcome identity.
 * NOT_STARTED → IN_PROGRESS → PROCESSED | FAILED
 * FAILED → IN_PROGRESS (explicit retry)
 */
export class InMemoryLearningCoordinator implements LearningCoordinator {
  private readonly fences = new Map<string, LearningFence>();
  private sequence = 0;

  async get(key: LearningFenceKey): Promise<LearningFence | null> {
    return this.fences.get(learningFenceKey(key)) ?? null;
  }

  async begin(
    key: LearningFenceKey,
    nowIso: string,
  ): Promise<BeginLearningResult> {
    const fenceKey = learningFenceKey(key);
    const existing = this.fences.get(fenceKey);
    if (existing) {
      if (existing.status === "IN_PROGRESS") {
        return { outcome: "IN_PROGRESS", fence: existing };
      }
      if (existing.status === "PROCESSED") {
        return { outcome: "ALREADY_PROCESSED", fence: existing };
      }
    }

    this.sequence += 1;
    const ownerToken = `learn_owner_${this.sequence}`;
    const fence: LearningFence = {
      fenceKey,
      runId: key.runId,
      outcome: key.outcome,
      ...(key.outcomeVerificationId !== undefined
        ? { outcomeVerificationId: key.outcomeVerificationId }
        : {}),
      status: "IN_PROGRESS",
      attempt: (existing?.attempt ?? 0) + 1,
      lastUpdatedAt: nowIso,
      ownerToken,
    };
    this.fences.set(fenceKey, fence);
    return { outcome: "STARTED", fence, ownerToken };
  }

  async markProcessed(
    key: LearningFenceKey,
    ownerToken: string,
    nowIso: string,
    historicalRunRecordId: string,
  ): Promise<LearningFence> {
    return this.transition(key, ownerToken, nowIso, "PROCESSED", {
      historicalRunRecordId,
    });
  }

  async markFailed(
    key: LearningFenceKey,
    ownerToken: string,
    nowIso: string,
    failureCode: string,
  ): Promise<LearningFence> {
    return this.transition(key, ownerToken, nowIso, "FAILED", { failureCode });
  }

  private transition(
    key: LearningFenceKey,
    ownerToken: string,
    nowIso: string,
    status: LearningFenceStatus,
    extras: { historicalRunRecordId?: string; failureCode?: string },
  ): LearningFence {
    const fenceKey = learningFenceKey(key);
    const existing = this.fences.get(fenceKey);
    if (!existing) {
      throw new MemoryError(
        "LEARNING_FENCE_FAILED",
        "Learning fence not found",
        { fenceKey },
      );
    }
    if (existing.ownerToken !== ownerToken) {
      throw new MemoryError(
        "LEARNING_FENCE_FAILED",
        "Learning fence owner token mismatch",
        { fenceKey },
      );
    }
    if (existing.status !== "IN_PROGRESS") {
      throw new MemoryError(
        "INVALID_LEARNING_STATE",
        `Cannot transition fence from ${existing.status} to ${status}`,
        { fenceKey, from: existing.status, to: status },
      );
    }
    const next: LearningFence = {
      ...existing,
      status,
      lastUpdatedAt: nowIso,
      ...(extras.historicalRunRecordId !== undefined
        ? { historicalRunRecordId: extras.historicalRunRecordId }
        : {}),
      ...(extras.failureCode !== undefined
        ? { failureCode: extras.failureCode }
        : {}),
    };
    this.fences.set(fenceKey, next);
    return next;
  }
}
