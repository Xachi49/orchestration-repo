import { z } from "zod";
import { PlanVersionSchema } from "../domain/plan/execution-plan.js";
import type { VerificationResult } from "../domain/verification/index.js";
import { VerificationError } from "./errors.js";

export const VerificationFenceStatusSchema = z.enum([
  "NOT_STARTED",
  "IN_PROGRESS",
  "DECIDED",
  "FAILED",
]);
export type VerificationFenceStatus = z.infer<
  typeof VerificationFenceStatusSchema
>;

export const VerificationFenceKeySchema = z
  .object({
    runId: z.string().min(1),
    executionAttemptId: z.string().min(1),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
  })
  .strict();
export type VerificationFenceKey = z.infer<typeof VerificationFenceKeySchema>;

export const VerificationFenceSchema = z
  .object({
    fenceKey: z.string().min(1),
    runId: z.string().min(1),
    executionAttemptId: z.string().min(1),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    status: VerificationFenceStatusSchema,
    attempt: z.number().int().nonnegative(),
    lastUpdatedAt: z.string().datetime(),
    ownerToken: z.string().min(1).optional(),
    failureCode: z.string().min(1).optional(),
    outcomeVerificationId: z.string().min(1).optional(),
    outcome: z.string().min(1).optional(),
  })
  .strict();
export type VerificationFence = z.infer<typeof VerificationFenceSchema>;

export function verificationFenceKey(key: VerificationFenceKey): string {
  const parsed = VerificationFenceKeySchema.parse(key);
  return [
    parsed.runId,
    parsed.executionAttemptId,
    parsed.planId,
    String(parsed.planVersion),
    parsed.planHash,
  ].join(":");
}

export type BeginVerificationResult =
  | { outcome: "STARTED"; fence: VerificationFence; ownerToken: string }
  | {
      outcome: "ALREADY_DECIDED";
      fence: VerificationFence;
      result?: VerificationResult;
    }
  | { outcome: "IN_PROGRESS"; fence: VerificationFence };

/**
 * Process-local verification fence.
 *
 * ```text
 * NOT_STARTED → IN_PROGRESS → DECIDED | FAILED
 * FAILED → IN_PROGRESS (explicit retry)
 * ```
 *
 * Same execution attempt must not verify concurrently twice.
 * Durable implementations must use CAS / unique fencing per key.
 * Retries never overwrite earlier attempt metadata (attempt counter increments).
 */
export interface VerificationCoordinator {
  get(key: VerificationFenceKey): Promise<VerificationFence | null>;
  begin(
    key: VerificationFenceKey,
    nowIso: string,
  ): Promise<BeginVerificationResult>;
  markDecided(
    key: VerificationFenceKey,
    ownerToken: string,
    nowIso: string,
    meta: { outcomeVerificationId: string; outcome: string },
  ): Promise<VerificationFence>;
  markFailed(
    key: VerificationFenceKey,
    ownerToken: string,
    nowIso: string,
    failureCode: string,
  ): Promise<VerificationFence>;
  storeResult(
    key: VerificationFenceKey,
    result: VerificationResult,
  ): Promise<void>;
  getResult(key: VerificationFenceKey): Promise<VerificationResult | null>;
}

export class InMemoryVerificationCoordinator
  implements VerificationCoordinator
{
  private readonly fences = new Map<string, VerificationFence>();
  private readonly results = new Map<string, VerificationResult>();
  private sequence = 0;

  async get(key: VerificationFenceKey): Promise<VerificationFence | null> {
    return this.fences.get(verificationFenceKey(key)) ?? null;
  }

  async begin(
    key: VerificationFenceKey,
    nowIso: string,
  ): Promise<BeginVerificationResult> {
    const fenceKey = verificationFenceKey(key);
    const existing = this.fences.get(fenceKey);
    if (existing) {
      if (existing.status === "IN_PROGRESS") {
        return { outcome: "IN_PROGRESS", fence: existing };
      }
      if (existing.status === "DECIDED") {
        const stored = this.results.get(fenceKey);
        return {
          outcome: "ALREADY_DECIDED",
          fence: existing,
          ...(stored !== undefined ? { result: stored } : {}),
        };
      }
      // FAILED → explicit retry → IN_PROGRESS
    }

    this.sequence += 1;
    const ownerToken = `ver_owner_${this.sequence}`;
    const fence: VerificationFence = {
      fenceKey,
      runId: key.runId,
      executionAttemptId: key.executionAttemptId,
      planId: key.planId,
      planVersion: key.planVersion,
      planHash: key.planHash,
      status: "IN_PROGRESS",
      attempt: (existing?.attempt ?? 0) + 1,
      lastUpdatedAt: nowIso,
      ownerToken,
    };
    this.fences.set(fenceKey, fence);
    return { outcome: "STARTED", fence, ownerToken };
  }

  async markDecided(
    key: VerificationFenceKey,
    ownerToken: string,
    nowIso: string,
    meta: { outcomeVerificationId: string; outcome: string },
  ): Promise<VerificationFence> {
    return this.transition(key, ownerToken, nowIso, "DECIDED", meta);
  }

  async markFailed(
    key: VerificationFenceKey,
    ownerToken: string,
    nowIso: string,
    failureCode: string,
  ): Promise<VerificationFence> {
    return this.transition(key, ownerToken, nowIso, "FAILED", { failureCode });
  }

  async storeResult(
    key: VerificationFenceKey,
    result: VerificationResult,
  ): Promise<void> {
    this.results.set(verificationFenceKey(key), result);
  }

  async getResult(
    key: VerificationFenceKey,
  ): Promise<VerificationResult | null> {
    return this.results.get(verificationFenceKey(key)) ?? null;
  }

  private transition(
    key: VerificationFenceKey,
    ownerToken: string,
    nowIso: string,
    status: VerificationFenceStatus,
    extras: {
      outcomeVerificationId?: string;
      outcome?: string;
      failureCode?: string;
    },
  ): VerificationFence {
    const fenceKey = verificationFenceKey(key);
    const existing = this.fences.get(fenceKey);
    if (!existing) {
      throw new VerificationError(
        "VERIFICATION_FENCE_FAILED",
        "Verification fence not found",
        { fenceKey },
      );
    }
    if (existing.ownerToken !== ownerToken) {
      throw new VerificationError(
        "VERIFICATION_FENCE_FAILED",
        "Verification fence owner token mismatch",
        { fenceKey },
      );
    }
    if (existing.status !== "IN_PROGRESS") {
      throw new VerificationError(
        "INVALID_VERIFICATION_STATE",
        `Cannot transition fence from ${existing.status} to ${status}`,
        { fenceKey, from: existing.status, to: status },
      );
    }
    const next: VerificationFence = {
      ...existing,
      status,
      lastUpdatedAt: nowIso,
      ...(extras.outcomeVerificationId !== undefined
        ? { outcomeVerificationId: extras.outcomeVerificationId }
        : {}),
      ...(extras.outcome !== undefined ? { outcome: extras.outcome } : {}),
      ...(extras.failureCode !== undefined
        ? { failureCode: extras.failureCode }
        : {}),
    };
    this.fences.set(fenceKey, next);
    return next;
  }
}
