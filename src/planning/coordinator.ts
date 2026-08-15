import { z } from "zod";
import { createHash } from "node:crypto";
import { PlanningError } from "./errors.js";

export const PlanningFenceStatusSchema = z.enum([
  "NOT_STARTED",
  "IN_PROGRESS",
  "PLANNED",
  "FAILED",
]);
export type PlanningFenceStatus = z.infer<typeof PlanningFenceStatusSchema>;

export const PlanningFenceSchema = z
  .object({
    runId: z.string().min(1),
    status: PlanningFenceStatusSchema,
    attempt: z.number().int().nonnegative(),
    lastUpdatedAt: z.string().datetime(),
    ownerToken: z.string().min(1).optional(),
    failureCode: z.string().min(1).optional(),
    failedAt: z.string().datetime().optional(),
    retryable: z.boolean().optional(),
    plannedAt: z.string().datetime().optional(),
    planId: z.string().min(1).optional(),
  })
  .strict();
export type PlanningFence = z.infer<typeof PlanningFenceSchema>;

export type BeginPlanningResult =
  | {
      outcome: "STARTED";
      fence: PlanningFence;
      ownerToken: string;
    }
  | {
      outcome: "ALREADY_PLANNED";
      fence: PlanningFence;
    };

/**
 * Per-run planning fencing.
 * In-memory adapters are not distributed. Durable implementations must use
 * atomic compare-and-set / unique run fencing.
 */
export interface PlanningCoordinator {
  get(runId: string): Promise<PlanningFence | null>;
  begin(runId: string, nowIso: string): Promise<BeginPlanningResult>;
  markPlanned(
    runId: string,
    ownerToken: string,
    nowIso: string,
    planId: string,
  ): Promise<PlanningFence>;
  markFailed(
    runId: string,
    ownerToken: string,
    failure: {
      failureCode: string;
      failedAt: string;
      retryable: boolean;
    },
  ): Promise<PlanningFence>;
  reconcilePlanned(
    runId: string,
    nowIso: string,
    planId: string,
  ): Promise<PlanningFence>;
}

export class InMemoryPlanningCoordinator implements PlanningCoordinator {
  private readonly byRun = new Map<string, PlanningFence>();
  private tokenCounter = 0;

  async get(runId: string): Promise<PlanningFence | null> {
    return this.byRun.get(runId) ?? null;
  }

  async begin(runId: string, nowIso: string): Promise<BeginPlanningResult> {
    const current = this.byRun.get(runId);
    if (current?.status === "IN_PROGRESS") {
      throw new PlanningError(
        "PLANNING_IN_PROGRESS",
        `Planning is already in progress for run ${runId}`,
        { runId, attempt: current.attempt },
      );
    }
    if (current?.status === "PLANNED") {
      return { outcome: "ALREADY_PLANNED", fence: current };
    }
    if (current?.status === "FAILED" && current.retryable === false) {
      throw new PlanningError(
        "INVALID_PLANNING_STATE",
        `Planning for run ${runId} failed and is not retryable`,
        { runId, failureCode: current.failureCode },
      );
    }

    this.tokenCounter += 1;
    const ownerToken = createHash("sha256")
      .update(`${runId}:plan:${this.tokenCounter}:${nowIso}`)
      .digest("hex")
      .slice(0, 32);

    const attempt =
      current?.status === "FAILED" ? current.attempt + 1 : 1;

    const fence = PlanningFenceSchema.parse({
      runId,
      status: "IN_PROGRESS",
      attempt,
      ownerToken,
      lastUpdatedAt: nowIso,
      retryable: true,
    });
    this.byRun.set(runId, fence);
    return { outcome: "STARTED", fence, ownerToken };
  }

  async markPlanned(
    runId: string,
    ownerToken: string,
    nowIso: string,
    planId: string,
  ): Promise<PlanningFence> {
    const current = this.requireOwnedInProgress(runId, ownerToken);
    const fence = PlanningFenceSchema.parse({
      runId,
      status: "PLANNED",
      attempt: current.attempt,
      lastUpdatedAt: nowIso,
      plannedAt: nowIso,
      planId,
      retryable: false,
    });
    this.byRun.set(runId, fence);
    return fence;
  }

  async markFailed(
    runId: string,
    ownerToken: string,
    failure: {
      failureCode: string;
      failedAt: string;
      retryable: boolean;
    },
  ): Promise<PlanningFence> {
    const current = this.requireOwnedInProgress(runId, ownerToken);
    const fence = PlanningFenceSchema.parse({
      runId,
      status: "FAILED",
      attempt: current.attempt,
      lastUpdatedAt: failure.failedAt,
      failureCode: failure.failureCode,
      failedAt: failure.failedAt,
      retryable: failure.retryable,
    });
    this.byRun.set(runId, fence);
    return fence;
  }

  async reconcilePlanned(
    runId: string,
    nowIso: string,
    planId: string,
  ): Promise<PlanningFence> {
    const current = this.byRun.get(runId);
    if (current?.status === "PLANNED") {
      return current;
    }
    const fence = PlanningFenceSchema.parse({
      runId,
      status: "PLANNED",
      attempt: current?.attempt ?? 1,
      lastUpdatedAt: nowIso,
      plannedAt: nowIso,
      planId,
      retryable: false,
    });
    this.byRun.set(runId, fence);
    return fence;
  }

  private requireOwnedInProgress(
    runId: string,
    ownerToken: string,
  ): PlanningFence {
    const current = this.byRun.get(runId);
    if (!current || current.status !== "IN_PROGRESS") {
      throw new PlanningError(
        "INVALID_PLANNING_STATE",
        `Planning fence for run ${runId} is not IN_PROGRESS`,
        { runId, status: current?.status },
      );
    }
    if (current.ownerToken !== ownerToken) {
      throw new PlanningError(
        "INVALID_PLANNING_STATE",
        `Planning ownership mismatch for run ${runId}`,
        { runId },
      );
    }
    return current;
  }
}
