import { z } from "zod";
import { PlanVersionSchema } from "../domain/plan/execution-plan.js";
import type { ExecutionResult } from "../domain/execution/index.js";
import { ExecutionError } from "./errors.js";

export const ExecutionFenceStatusSchema = z.enum([
  "NOT_STARTED",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
  "CONTAINED",
]);
export type ExecutionFenceStatus = z.infer<typeof ExecutionFenceStatusSchema>;

export const ExecutionFenceKeySchema = z
  .object({
    runId: z.string().min(1),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    authorizationRecordId: z.string().min(1),
  })
  .strict();
export type ExecutionFenceKey = z.infer<typeof ExecutionFenceKeySchema>;

export const ExecutionFenceSchema = z
  .object({
    fenceKey: z.string().min(1),
    runId: z.string().min(1),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    authorizationRecordId: z.string().min(1),
    status: ExecutionFenceStatusSchema,
    attempt: z.number().int().nonnegative(),
    lastUpdatedAt: z.string().datetime(),
    ownerToken: z.string().min(1).optional(),
    failureCode: z.string().min(1).optional(),
    executionAttemptId: z.string().min(1).optional(),
    resultStatus: z.string().min(1).optional(),
  })
  .strict();
export type ExecutionFence = z.infer<typeof ExecutionFenceSchema>;

export function executionFenceKey(key: ExecutionFenceKey): string {
  const parsed = ExecutionFenceKeySchema.parse(key);
  return [
    parsed.runId,
    parsed.planId,
    String(parsed.planVersion),
    parsed.planHash,
    parsed.authorizationRecordId,
  ].join(":");
}

export type BeginExecutionResult =
  | { outcome: "STARTED"; fence: ExecutionFence; ownerToken: string }
  | { outcome: "ALREADY_COMPLETED"; fence: ExecutionFence; result?: ExecutionResult }
  | { outcome: "IN_PROGRESS"; fence: ExecutionFence };

/**
 * Process-local execution fence.
 *
 * ```text
 * NOT_STARTED → IN_PROGRESS → COMPLETED | FAILED | CONTAINED
 * FAILED → IN_PROGRESS (explicit retry)
 * ```
 *
 * Concurrent execution of the same authorization must not run twice.
 * Durable implementations must use CAS / unique fencing per key.
 */
export interface ExecutionCoordinator {
  get(key: ExecutionFenceKey): Promise<ExecutionFence | null>;
  begin(
    key: ExecutionFenceKey,
    nowIso: string,
  ): Promise<BeginExecutionResult>;
  markCompleted(
    key: ExecutionFenceKey,
    ownerToken: string,
    nowIso: string,
    meta: { executionAttemptId: string; resultStatus: string },
  ): Promise<ExecutionFence>;
  markFailed(
    key: ExecutionFenceKey,
    ownerToken: string,
    nowIso: string,
    failureCode: string,
  ): Promise<ExecutionFence>;
  markContained(
    key: ExecutionFenceKey,
    ownerToken: string,
    nowIso: string,
    failureCode: string,
  ): Promise<ExecutionFence>;
  storeResult(key: ExecutionFenceKey, result: ExecutionResult): Promise<void>;
  getResult(key: ExecutionFenceKey): Promise<ExecutionResult | null>;
}

export class InMemoryExecutionCoordinator implements ExecutionCoordinator {
  private readonly fences = new Map<string, ExecutionFence>();
  private readonly results = new Map<string, ExecutionResult>();
  private sequence = 0;

  async get(key: ExecutionFenceKey): Promise<ExecutionFence | null> {
    return this.fences.get(executionFenceKey(key)) ?? null;
  }

  async begin(
    key: ExecutionFenceKey,
    nowIso: string,
  ): Promise<BeginExecutionResult> {
    const fenceKey = executionFenceKey(key);
    const existing = this.fences.get(fenceKey);
    if (existing) {
      if (existing.status === "IN_PROGRESS") {
        return { outcome: "IN_PROGRESS", fence: existing };
      }
      if (existing.status === "COMPLETED" || existing.status === "CONTAINED") {
        const stored = this.results.get(fenceKey);
        if (stored) {
          return {
            outcome: "ALREADY_COMPLETED",
            fence: existing,
            result: stored,
          };
        }
        return { outcome: "ALREADY_COMPLETED", fence: existing };
      }
      // FAILED → explicit retry → IN_PROGRESS
    }

    this.sequence += 1;
    const ownerToken = `exec_owner_${this.sequence}`;
    const fence: ExecutionFence = {
      fenceKey,
      runId: key.runId,
      planId: key.planId,
      planVersion: key.planVersion,
      planHash: key.planHash,
      authorizationRecordId: key.authorizationRecordId,
      status: "IN_PROGRESS",
      attempt: (existing?.attempt ?? 0) + 1,
      lastUpdatedAt: nowIso,
      ownerToken,
    };
    this.fences.set(fenceKey, fence);
    return { outcome: "STARTED", fence, ownerToken };
  }

  async markCompleted(
    key: ExecutionFenceKey,
    ownerToken: string,
    nowIso: string,
    meta: { executionAttemptId: string; resultStatus: string },
  ): Promise<ExecutionFence> {
    return this.transition(key, ownerToken, nowIso, "COMPLETED", meta);
  }

  async markFailed(
    key: ExecutionFenceKey,
    ownerToken: string,
    nowIso: string,
    failureCode: string,
  ): Promise<ExecutionFence> {
    return this.transition(key, ownerToken, nowIso, "FAILED", {
      failureCode,
    });
  }

  async markContained(
    key: ExecutionFenceKey,
    ownerToken: string,
    nowIso: string,
    failureCode: string,
  ): Promise<ExecutionFence> {
    return this.transition(key, ownerToken, nowIso, "CONTAINED", {
      failureCode,
    });
  }

  async storeResult(
    key: ExecutionFenceKey,
    result: ExecutionResult,
  ): Promise<void> {
    this.results.set(executionFenceKey(key), result);
  }

  async getResult(key: ExecutionFenceKey): Promise<ExecutionResult | null> {
    return this.results.get(executionFenceKey(key)) ?? null;
  }

  private transition(
    key: ExecutionFenceKey,
    ownerToken: string,
    nowIso: string,
    status: ExecutionFenceStatus,
    extras: {
      executionAttemptId?: string;
      resultStatus?: string;
      failureCode?: string;
    },
  ): ExecutionFence {
    const fenceKey = executionFenceKey(key);
    const existing = this.fences.get(fenceKey);
    if (!existing) {
      throw new ExecutionError(
        "EXECUTION_FENCE_FAILED",
        "No fence to transition",
      );
    }
    if (existing.ownerToken !== ownerToken) {
      throw new ExecutionError(
        "EXECUTION_FENCE_FAILED",
        "Fence owner token mismatch",
      );
    }
    if (existing.status !== "IN_PROGRESS") {
      throw new ExecutionError(
        "EXECUTION_FENCE_FAILED",
        `Fence is ${existing.status}, expected IN_PROGRESS`,
      );
    }
    const next: ExecutionFence = {
      ...existing,
      status,
      lastUpdatedAt: nowIso,
      ...(extras.executionAttemptId !== undefined
        ? { executionAttemptId: extras.executionAttemptId }
        : {}),
      ...(extras.resultStatus !== undefined
        ? { resultStatus: extras.resultStatus }
        : {}),
      ...(extras.failureCode !== undefined
        ? { failureCode: extras.failureCode }
        : {}),
    };
    this.fences.set(fenceKey, next);
    return next;
  }
}
