import type { ResourceBudgetProfile } from "../control-plane/budgets/budget.js";
import type { ExecutionResourceUsage } from "./resource-ledger.js";

export interface ExecutionResourceLedgerRecord {
  executionAttemptId: string;
  runId: string;
  projectId: string;
  budgetProfileId: string;
  usage: ExecutionResourceUsage;
  ceilingDurationMs: number;
  ceilingApiCalls: number;
  ceilingPlanSteps: number;
  recordRevision: number;
}

export interface ExecutionResourceLedgerStore {
  initialize(input: {
    executionAttemptId: string;
    runId: string;
    projectId: string;
    budget: ResourceBudgetProfile;
  }): Promise<ExecutionResourceLedgerRecord>;

  load(executionAttemptId: string): Promise<ExecutionResourceLedgerRecord | null>;

  reserveDurationMs(
    executionAttemptId: string,
    expectedRevision: number,
    ms: number,
  ): Promise<ExecutionResourceLedgerRecord>;

  settleReservedDuration(
    executionAttemptId: string,
    expectedRevision: number,
    reservedMs: number,
    actualMs: number,
  ): Promise<ExecutionResourceLedgerRecord>;

  releaseReservation(
    executionAttemptId: string,
    expectedRevision: number,
    reservedMs: number,
  ): Promise<ExecutionResourceLedgerRecord>;

  recordStep(
    executionAttemptId: string,
    expectedRevision: number,
    delta: Partial<ExecutionResourceUsage>,
  ): Promise<ExecutionResourceLedgerRecord>;
}
