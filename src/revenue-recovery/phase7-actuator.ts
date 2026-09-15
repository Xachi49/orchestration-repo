import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ActuatorRuntimeBounds,
  RecoveryOutreachActuatorResult,
} from "../execution/actuator.js";
import type {
  CreateCallbackTaskArgs,
  SendRecoveryEmailArgs,
  SendRecoverySmsArgs,
} from "../execution/action-schemas.js";
import { ExecutionError } from "../execution/errors.js";
import { resolveContained } from "../ingestion/workspace-paths.js";
import type { RevenueRecoveryService } from "./service.js";
import { isRevenueRecoveryError } from "./errors.js";

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Phase7 product actuator for Revenue Recovery outreach.
 * Does NOT assess Phase6 authorization — canonical Phase7 readiness/preflight
 * must already have validated the AuthorizationRecord before invocation.
 */
export class RevenueRecoveryPhase7Actuator {
  constructor(private readonly recovery: RevenueRecoveryService) {}

  async sendRecoverySms(input: {
    runId: string;
    executionAttemptId: string;
    stepId: string;
    stepIdempotencyKey: string;
    artifactRoot: string;
    args: SendRecoverySmsArgs;
    nowIso: string;
    runtime: ActuatorRuntimeBounds;
  }): Promise<RecoveryOutreachActuatorResult> {
    return this.actuate({
      ...input,
      actionType: "SEND_RECOVERY_SMS",
      args: input.args,
    });
  }

  async sendRecoveryEmail(input: {
    runId: string;
    executionAttemptId: string;
    stepId: string;
    stepIdempotencyKey: string;
    artifactRoot: string;
    args: SendRecoveryEmailArgs;
    nowIso: string;
    runtime: ActuatorRuntimeBounds;
  }): Promise<RecoveryOutreachActuatorResult> {
    return this.actuate({
      ...input,
      actionType: "SEND_RECOVERY_EMAIL",
      args: input.args,
    });
  }

  async createRecoveryCallbackTask(input: {
    runId: string;
    executionAttemptId: string;
    stepId: string;
    stepIdempotencyKey: string;
    artifactRoot: string;
    args: CreateCallbackTaskArgs;
    nowIso: string;
    runtime: ActuatorRuntimeBounds;
  }): Promise<RecoveryOutreachActuatorResult> {
    return this.actuate({
      ...input,
      actionType: "CREATE_CALLBACK_TASK",
      args: input.args,
    });
  }

  private async actuate(input: {
    runId: string;
    executionAttemptId: string;
    stepId: string;
    stepIdempotencyKey: string;
    artifactRoot: string;
    actionType:
      | "SEND_RECOVERY_SMS"
      | "SEND_RECOVERY_EMAIL"
      | "CREATE_CALLBACK_TASK";
    args: SendRecoverySmsArgs | SendRecoveryEmailArgs | CreateCallbackTaskArgs;
    nowIso: string;
    runtime: ActuatorRuntimeBounds;
  }): Promise<RecoveryOutreachActuatorResult> {
    if (input.runtime.timeoutMs <= 0) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        "Recovery actuator refused to start: timeoutMs must be positive",
        { timeoutMs: input.runtime.timeoutMs },
      );
    }
    try {
      const result = await this.recovery.actuateRecoveryOutreachFromPhase7({
        actionType: input.actionType,
        args: input.args,
        runId: input.runId,
        executionAttemptId: input.executionAttemptId,
        stepId: input.stepId,
        stepIdempotencyKey: input.stepIdempotencyKey,
      });
      const relativePath = path.posix.join(
        "recovery-attempts",
        `${input.stepId}.json`,
      );
      const absolute = resolveContained(input.artifactRoot, relativePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      const body = JSON.stringify({
        attemptId: result.attempt.attemptId,
        channel: result.attempt.channel,
        deliveryOutcome: result.attempt.deliveryOutcome,
        providerMessageId: result.attempt.providerMessageId ?? null,
        executionActionIdentity: result.attempt.executionActionIdentity,
        replayed: result.replayed,
        runId: input.runId,
        executionAttemptId: input.executionAttemptId,
        stepId: input.stepId,
        createdAt: input.nowIso,
      });
      await writeFile(absolute, body, "utf8");
      return {
        artifactRelativePath: relativePath,
        contentHash: hashContent(body),
        size: Buffer.byteLength(body, "utf8"),
        attemptId: result.attempt.attemptId,
        channel: result.attempt.channel,
        deliveryOutcome: result.attempt.deliveryOutcome,
        ...(result.attempt.providerMessageId
          ? { providerMessageId: result.attempt.providerMessageId }
          : {}),
        replayed: result.replayed,
      };
    } catch (error) {
      if (isRevenueRecoveryError(error)) {
        throw new ExecutionError(
          error.code === "RECOVERY_ACTION_TARGET_MISMATCH"
            ? "EXECUTION_TARGET_INVALID"
            : error.code === "CONTACT_NOT_PERMITTED" ||
                error.code === "CONTACT_WINDOW_CLOSED" ||
                error.code === "RECOVERY_SUPPRESSED"
              ? "EXECUTION_PRECONDITION_FAILED"
              : "STEP_EXECUTION_FAILED",
          error.message,
          { revenueRecoveryCode: error.code, ...(error.details ?? {}) },
        );
      }
      throw error;
    }
  }
}
