import type { RunRecord } from "../admission/run-repository.js";
import type { AuthorizationRecord } from "../domain/authorization/index.js";
import type { ExecutionAttempt } from "../domain/execution/index.js";
import type { LearningLedgerEvent } from "../domain/memory/index.js";
import type { SystemHealthSnapshot } from "../domain/observability/index.js";
import type { PlanVersion } from "../domain/plan/execution-plan.js";
import type { ValidationDecision } from "../domain/validation/index.js";
import type { CompletionRecord } from "../domain/verification/index.js";
import type { VerifiedRepositoryContext } from "../ingestion/context.js";
import type { StoredPlanRecord } from "../planning/plan-repository.js";
import type { DiscoveryContext } from "./discovery-map.js";
import type { RunArtifactProbe } from "./service.js";

/**
 * Durable stores the probe reads. Structural on purpose: the scheduler asks
 * what already exists, it never creates or advances phase artifacts.
 */
export interface RunArtifactProbeDeps {
  contexts: {
    getByRunId(runId: string): Promise<VerifiedRepositoryContext | null>;
  };
  plans: {
    getByRunId(runId: string): Promise<StoredPlanRecord | null>;
  };
  validationDecisions: {
    getByPlan(
      runId: string,
      planId: string,
      planVersion: PlanVersion,
    ): Promise<ValidationDecision | null>;
  };
  authorizationRecords: {
    getLatestByRun(runId: string): Promise<AuthorizationRecord | null>;
  };
  executionAttempts: {
    getLatestByRun(runId: string): Promise<ExecutionAttempt | null>;
  };
  completions: {
    getByRun(runId: string): Promise<CompletionRecord | null>;
  };
  learningLedger: {
    listByRun(runId: string): Promise<readonly LearningLedgerEvent[]>;
  };
  healthSnapshots: {
    listByProject(projectId: string): Promise<readonly SystemHealthSnapshot[]>;
  };
}

/** Attempt statuses that are settled enough for Phase 8 to verify. */
const TERMINAL_ATTEMPT_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "PARTIAL",
  "CONTAINED",
]);

/** Validation outcomes that route to the human authorization gate. */
const ROUTABLE_VALIDATION_DECISIONS = new Set([
  "PASS",
  "HUMAN_APPROVAL_REQUIRED",
]);

/**
 * Reads durable phase artifacts so discovery can propose next work.
 *
 * Fail closed: an artifact counts only when it is present, bound to the live
 * plan, and in a settled state. Absent or mismatched artifacts read as absent,
 * which withholds work rather than inventing it. Store failures propagate —
 * an unreadable store must never be read as "artifact present".
 */
export class StackRunArtifactProbe implements RunArtifactProbe {
  constructor(private readonly deps: RunArtifactProbeDeps) {}

  async hasVerifiedRepository(runId: string): Promise<boolean> {
    const context = await this.deps.contexts.getByRunId(runId);
    return context !== null && context.status === "VERIFIED";
  }

  async hasPlan(runId: string): Promise<boolean> {
    const plan = await this.deps.plans.getByRunId(runId);
    return plan !== null && plan.status !== "SUPERSEDED";
  }

  /**
   * Live planning binding. When no plan exists yet the repository fingerprint
   * still binds PLAN_RUN work, so re-ingestion invalidates pending plan work.
   * Absent plan identity uses the same `0` / `none` fallback the binding hash
   * applies for unknown fingerprints.
   */
  async planBinding(runId: string): Promise<{
    planVersion: number;
    planHash: string;
    repositoryFingerprint: string;
  } | null> {
    const context = await this.deps.contexts.getByRunId(runId);
    if (!context || context.status !== "VERIFIED") {
      return null;
    }
    const plan = await this.deps.plans.getByRunId(runId);
    if (!plan || plan.status === "SUPERSEDED") {
      return {
        planVersion: 0,
        planHash: "none",
        repositoryFingerprint: context.repositoryFingerprint,
      };
    }
    return {
      planVersion: plan.planVersion,
      planHash: plan.planHash,
      repositoryFingerprint: context.repositoryFingerprint,
    };
  }

  async hasValidationPassOrApprovalRequired(runId: string): Promise<boolean> {
    const decision = await this.livePlanValidationDecision(runId);
    return (
      decision !== null && ROUTABLE_VALIDATION_DECISIONS.has(decision.decision)
    );
  }

  async validationDecisionId(runId: string): Promise<string | null> {
    const decision = await this.livePlanValidationDecision(runId);
    return decision?.validationDecisionId ?? null;
  }

  /**
   * AUTHORIZATION RECORD != APPROVAL. Only an APPROVE record binds execution;
   * REJECT and REQUEST_MODIFICATION records grant nothing.
   */
  async authorizationRecordId(runId: string): Promise<string | null> {
    const record = await this.deps.authorizationRecords.getLatestByRun(runId);
    if (!record || record.decision !== "APPROVE") {
      return null;
    }
    return record.authorizationRecordId;
  }

  async executionAttemptId(runId: string): Promise<string | null> {
    const attempt = await this.deps.executionAttempts.getLatestByRun(runId);
    return attempt?.executionAttemptId ?? null;
  }

  async hasExecutionTerminalForVerification(runId: string): Promise<boolean> {
    const attempt = await this.deps.executionAttempts.getLatestByRun(runId);
    if (!attempt) {
      return false;
    }
    return (
      TERMINAL_ATTEMPT_STATUSES.has(attempt.status) &&
      attempt.completedAt !== undefined
    );
  }

  async completionRecord(runId: string): Promise<CompletionRecord | null> {
    return this.deps.completions.getByRun(runId);
  }

  async hasLearned(runId: string): Promise<boolean> {
    const events = await this.deps.learningLedger.listByRun(runId);
    return events.some(
      (event) => event.eventType === "HISTORICAL_RUN_RECORDED",
    );
  }

  async hasObservabilitySnapshot(projectId: string): Promise<boolean> {
    const snapshots = await this.deps.healthSnapshots.listByProject(projectId);
    return snapshots.length > 0;
  }

  private async livePlanValidationDecision(
    runId: string,
  ): Promise<ValidationDecision | null> {
    const plan = await this.deps.plans.getByRunId(runId);
    if (!plan || plan.status === "SUPERSEDED") {
      return null;
    }
    return this.deps.validationDecisions.getByPlan(
      runId,
      plan.planId,
      plan.planVersion,
    );
  }
}

/** Durable fingerprints that bind work to the artifacts it was created for. */
export interface RunBindingFingerprints {
  repositoryFingerprint?: string;
  planVersion?: number;
  planHash?: string;
  authorizationRecordId?: string;
  validationDecisionId?: string;
  executionAttemptId?: string;
  completionRecordId?: string;
  runId: string;
}

export async function buildRunBindingFingerprints(
  artifacts: RunArtifactProbe,
  runId: string,
): Promise<RunBindingFingerprints> {
  const [
    plan,
    validationDecisionId,
    authorizationRecordId,
    executionAttemptId,
    completion,
  ] = await Promise.all([
    artifacts.planBinding(runId),
    artifacts.validationDecisionId(runId),
    artifacts.authorizationRecordId(runId),
    artifacts.executionAttemptId(runId),
    artifacts.completionRecord(runId),
  ]);
  return {
    runId,
    ...(plan
      ? {
          repositoryFingerprint: plan.repositoryFingerprint,
          planVersion: plan.planVersion,
          planHash: plan.planHash,
        }
      : {}),
    ...(validationDecisionId ? { validationDecisionId } : {}),
    ...(authorizationRecordId ? { authorizationRecordId } : {}),
    ...(executionAttemptId ? { executionAttemptId } : {}),
    ...(completion ? { completionRecordId: completion.completionRecordId } : {}),
  };
}

export async function buildDiscoveryContext(
  artifacts: RunArtifactProbe,
  run: RunRecord,
): Promise<DiscoveryContext> {
  const [
    hasVerifiedRepository,
    hasPlan,
    hasValidationPassOrApprovalRequired,
    authorizationRecordId,
    hasExecutionTerminalForVerification,
    completion,
    hasLearned,
    hasObservabilitySnapshot,
  ] = await Promise.all([
    artifacts.hasVerifiedRepository(run.runId),
    artifacts.hasPlan(run.runId),
    artifacts.hasValidationPassOrApprovalRequired(run.runId),
    artifacts.authorizationRecordId(run.runId),
    artifacts.hasExecutionTerminalForVerification(run.runId),
    artifacts.completionRecord(run.runId),
    artifacts.hasLearned(run.runId),
    artifacts.hasObservabilitySnapshot(run.projectId),
  ]);
  return {
    runState: run.state,
    hasVerifiedRepository,
    hasPlan,
    hasValidationPassOrApprovalRequired,
    hasAuthorizationRecord: Boolean(authorizationRecordId),
    hasExecutionTerminalForVerification,
    hasCompletionRecord: Boolean(completion),
    hasLearned,
    hasObservabilitySnapshot,
  };
}
