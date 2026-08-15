import { z } from "zod";
import { createHash } from "node:crypto";
import { PlanVersionSchema } from "../domain/plan/execution-plan.js";
import { ValidationDecisionClassSchema } from "../domain/validation/index.js";
import { ValidationError } from "./errors.js";

export const ValidationFenceStatusSchema = z.enum([
  "NOT_STARTED",
  "IN_PROGRESS",
  "DECIDED",
  "FAILED",
]);
export type ValidationFenceStatus = z.infer<typeof ValidationFenceStatusSchema>;

/**
 * Fence identity is the exact plan under validation, not just the run.
 *
 * A run may legitimately validate several plan versions in sequence; each one
 * gets its own fence, so a revision is never mistaken for a concurrent
 * validation of the same artifact.
 */
export const ValidationFenceKeySchema = z
  .object({
    runId: z.string().min(1),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
  })
  .strict();
export type ValidationFenceKey = z.infer<typeof ValidationFenceKeySchema>;

export const ValidationFenceSchema = z
  .object({
    fenceKey: z.string().min(1),
    runId: z.string().min(1),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    status: ValidationFenceStatusSchema,
    attempt: z.number().int().nonnegative(),
    lastUpdatedAt: z.string().datetime(),
    ownerToken: z.string().min(1).optional(),
    failureCode: z.string().min(1).optional(),
    failedAt: z.string().datetime().optional(),
    retryable: z.boolean().optional(),
    decidedAt: z.string().datetime().optional(),
    validationDecisionId: z.string().min(1).optional(),
    decision: ValidationDecisionClassSchema.optional(),
  })
  .strict();
export type ValidationFence = z.infer<typeof ValidationFenceSchema>;

export function validationFenceKey(key: ValidationFenceKey): string {
  const parsed = ValidationFenceKeySchema.parse(key);
  return `${parsed.runId}:${parsed.planId}:${parsed.planVersion}:${parsed.planHash}`;
}

export type BeginValidationResult =
  | {
      outcome: "STARTED";
      fence: ValidationFence;
      ownerToken: string;
    }
  | {
      outcome: "ALREADY_DECIDED";
      fence: ValidationFence;
    };

/**
 * Per-plan validation fencing.
 *
 * ```text
 * NOT_STARTED → IN_PROGRESS → DECIDED
 *                    ↓
 *                  FAILED → (explicit retry) → IN_PROGRESS
 * ```
 *
 * In-memory adapters are not distributed. Durable implementations must use
 * atomic compare-and-set / unique fencing per plan identity.
 */
export interface ValidationCoordinator {
  get(key: ValidationFenceKey): Promise<ValidationFence | null>;
  begin(
    key: ValidationFenceKey,
    nowIso: string,
  ): Promise<BeginValidationResult>;
  markDecided(
    key: ValidationFenceKey,
    ownerToken: string,
    nowIso: string,
    decision: {
      validationDecisionId: string;
      decision: z.infer<typeof ValidationDecisionClassSchema>;
    },
  ): Promise<ValidationFence>;
  markFailed(
    key: ValidationFenceKey,
    ownerToken: string,
    failure: {
      failureCode: string;
      failedAt: string;
      retryable: boolean;
    },
  ): Promise<ValidationFence>;
  reconcileDecided(
    key: ValidationFenceKey,
    nowIso: string,
    decision: {
      validationDecisionId: string;
      decision: z.infer<typeof ValidationDecisionClassSchema>;
    },
  ): Promise<ValidationFence>;
  listByRunId(runId: string): Promise<readonly ValidationFence[]>;
}

export class InMemoryValidationCoordinator implements ValidationCoordinator {
  private readonly byKey = new Map<string, ValidationFence>();
  private tokenCounter = 0;

  async get(key: ValidationFenceKey): Promise<ValidationFence | null> {
    return this.byKey.get(validationFenceKey(key)) ?? null;
  }

  async begin(
    key: ValidationFenceKey,
    nowIso: string,
  ): Promise<BeginValidationResult> {
    const fenceKey = validationFenceKey(key);
    const current = this.byKey.get(fenceKey);
    if (current?.status === "IN_PROGRESS") {
      throw new ValidationError(
        "VALIDATION_IN_PROGRESS",
        `Validation is already in progress for plan ${key.planId} v${key.planVersion}`,
        { runId: key.runId, planId: key.planId, attempt: current.attempt },
      );
    }
    if (current?.status === "DECIDED") {
      return { outcome: "ALREADY_DECIDED", fence: current };
    }
    if (current?.status === "FAILED" && current.retryable === false) {
      throw new ValidationError(
        "INVALID_VALIDATION_STATE",
        `Validation for plan ${key.planId} failed and is not retryable`,
        { runId: key.runId, failureCode: current.failureCode },
      );
    }

    this.tokenCounter += 1;
    const ownerToken = createHash("sha256")
      .update(`${fenceKey}:validate:${this.tokenCounter}:${nowIso}`)
      .digest("hex")
      .slice(0, 32);

    const fence = ValidationFenceSchema.parse({
      fenceKey,
      runId: key.runId,
      planId: key.planId,
      planVersion: key.planVersion,
      planHash: key.planHash,
      status: "IN_PROGRESS",
      attempt: current?.status === "FAILED" ? current.attempt + 1 : 1,
      ownerToken,
      lastUpdatedAt: nowIso,
      retryable: true,
    });
    this.byKey.set(fenceKey, fence);
    return { outcome: "STARTED", fence, ownerToken };
  }

  async markDecided(
    key: ValidationFenceKey,
    ownerToken: string,
    nowIso: string,
    decision: {
      validationDecisionId: string;
      decision: z.infer<typeof ValidationDecisionClassSchema>;
    },
  ): Promise<ValidationFence> {
    const current = this.requireOwnedInProgress(key, ownerToken);
    const fenceKey = validationFenceKey(key);
    const fence = ValidationFenceSchema.parse({
      fenceKey,
      runId: key.runId,
      planId: key.planId,
      planVersion: key.planVersion,
      planHash: key.planHash,
      status: "DECIDED",
      attempt: current.attempt,
      lastUpdatedAt: nowIso,
      decidedAt: nowIso,
      validationDecisionId: decision.validationDecisionId,
      decision: decision.decision,
      retryable: false,
    });
    this.byKey.set(fenceKey, fence);
    return fence;
  }

  async markFailed(
    key: ValidationFenceKey,
    ownerToken: string,
    failure: {
      failureCode: string;
      failedAt: string;
      retryable: boolean;
    },
  ): Promise<ValidationFence> {
    const current = this.requireOwnedInProgress(key, ownerToken);
    const fenceKey = validationFenceKey(key);
    const fence = ValidationFenceSchema.parse({
      fenceKey,
      runId: key.runId,
      planId: key.planId,
      planVersion: key.planVersion,
      planHash: key.planHash,
      status: "FAILED",
      attempt: current.attempt,
      lastUpdatedAt: failure.failedAt,
      failureCode: failure.failureCode,
      failedAt: failure.failedAt,
      retryable: failure.retryable,
    });
    this.byKey.set(fenceKey, fence);
    return fence;
  }

  async reconcileDecided(
    key: ValidationFenceKey,
    nowIso: string,
    decision: {
      validationDecisionId: string;
      decision: z.infer<typeof ValidationDecisionClassSchema>;
    },
  ): Promise<ValidationFence> {
    const fenceKey = validationFenceKey(key);
    const current = this.byKey.get(fenceKey);
    if (current?.status === "DECIDED") {
      return current;
    }
    const fence = ValidationFenceSchema.parse({
      fenceKey,
      runId: key.runId,
      planId: key.planId,
      planVersion: key.planVersion,
      planHash: key.planHash,
      status: "DECIDED",
      attempt: current?.attempt ?? 1,
      lastUpdatedAt: nowIso,
      decidedAt: nowIso,
      validationDecisionId: decision.validationDecisionId,
      decision: decision.decision,
      retryable: false,
    });
    this.byKey.set(fenceKey, fence);
    return fence;
  }

  async listByRunId(runId: string): Promise<readonly ValidationFence[]> {
    return [...this.byKey.values()]
      .filter((fence) => fence.runId === runId)
      .sort((a, b) => a.planVersion - b.planVersion);
  }

  private requireOwnedInProgress(
    key: ValidationFenceKey,
    ownerToken: string,
  ): ValidationFence {
    const current = this.byKey.get(validationFenceKey(key));
    if (!current || current.status !== "IN_PROGRESS") {
      throw new ValidationError(
        "INVALID_VALIDATION_STATE",
        `Validation fence for plan ${key.planId} is not IN_PROGRESS`,
        { runId: key.runId, status: current?.status },
      );
    }
    if (current.ownerToken !== ownerToken) {
      throw new ValidationError(
        "INVALID_VALIDATION_STATE",
        `Validation ownership mismatch for plan ${key.planId}`,
        { runId: key.runId },
      );
    }
    return current;
  }
}
