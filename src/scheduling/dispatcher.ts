import type { SchedulerWorkItem } from "./work-item.js";
import { SchedulingError } from "./errors.js";

export interface WorkFailureInput {
  failureClass: string;
  reasonCode: string;
  message: string;
  retryable: boolean;
}

/**
 * Work-state writes the dispatcher performs. Narrow on purpose so a caller can
 * interpose lease fencing: a worker that lost its lease must not write terminal
 * state. Satisfied by `PortfolioSchedulerService`.
 */
export interface SchedulerWorkStateWriter {
  markStale(
    work: SchedulerWorkItem,
    reasonCode: string,
  ): Promise<SchedulerWorkItem>;
  markRunning(work: SchedulerWorkItem): Promise<SchedulerWorkItem>;
  markSucceeded(
    work: SchedulerWorkItem,
    resultRef?: string,
  ): Promise<SchedulerWorkItem>;
  markFailed(
    work: SchedulerWorkItem,
    input: WorkFailureInput,
  ): Promise<SchedulerWorkItem>;
}

export interface PhaseDispatchPorts {
  ingest: (
    runId: string,
    projectId: string,
    environment: string,
  ) => Promise<{ resultRef?: string }>;
  plan: (runId: string) => Promise<{ resultRef?: string }>;
  validate: (runId: string) => Promise<{ resultRef?: string }>;
  routeAuthorization: (runId: string) => Promise<{ resultRef?: string }>;
  execute: (runId: string) => Promise<{ resultRef?: string }>;
  verify: (runId: string) => Promise<{ resultRef?: string }>;
  learn: (runId: string) => Promise<{ resultRef?: string }>;
  rebuildObservability: (
    projectId: string,
  ) => Promise<{ resultRef?: string }>;
  decomposeProgram: (programId: string) => Promise<{ resultRef?: string }>;
  validateProgram: (programId: string) => Promise<{ resultRef?: string }>;
  routeProgramMaterialization: (
    programId: string,
  ) => Promise<{ resultRef?: string }>;
  materializeProgram: (programId: string) => Promise<{ resultRef?: string }>;
  reconcileProgram: (programId: string) => Promise<{ resultRef?: string }>;
  verifyProgram: (programId: string) => Promise<{ resultRef?: string }>;
  analyzePortfolio: (portfolioId: string) => Promise<{ resultRef?: string }>;
  planPortfolio: (portfolioId: string) => Promise<{ resultRef?: string }>;
  validatePortfolio: (portfolioId: string) => Promise<{ resultRef?: string }>;
  routePortfolioAuthorization: (
    portfolioId: string,
  ) => Promise<{ resultRef?: string }>;
  materializePortfolioPrograms: (
    portfolioId: string,
  ) => Promise<{ resultRef?: string }>;
  reconcilePortfolio: (portfolioId: string) => Promise<{ resultRef?: string }>;
  verifyPortfolio: (portfolioId: string) => Promise<{ resultRef?: string }>;
  rebalancePortfolio: (portfolioId: string) => Promise<{ resultRef?: string }>;
  /**
   * Pre-dispatch readiness / binding recheck. Must fail closed on drift.
   */
  assertDispatchReady: (
    work: SchedulerWorkItem,
  ) => Promise<{ ok: true } | { ok: false; reasonCode: string; message: string }>;
  defaultEnvironment: string;
}

/**
 * Maps work kinds onto existing application services.
 * Does not duplicate phase logic.
 */
export class SchedulerDispatcher {
  constructor(
    private readonly scheduler: SchedulerWorkStateWriter,
    private readonly ports: PhaseDispatchPorts,
  ) {}

  async dispatch(work: SchedulerWorkItem): Promise<{
    work: SchedulerWorkItem;
    resultRef?: string;
  }> {
    const ready = await this.ports.assertDispatchReady(work);
    if (!ready.ok) {
      await this.scheduler.markStale(work, ready.reasonCode);
      throw new SchedulingError(
        "DISPATCH_READINESS_FAILED",
        ready.message,
        { reasonCode: ready.reasonCode, workItemId: work.workItemId },
      );
    }
    const running = await this.scheduler.markRunning(work);
    try {
      const outcome = await this.invoke(running);
      const succeeded = await this.scheduler.markSucceeded(
        running,
        outcome.resultRef,
      );
      return {
        work: succeeded,
        ...(outcome.resultRef ? { resultRef: outcome.resultRef } : {}),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 500) : "dispatch failed";
      const retryable = isSafeRetryable(error);
      const failed = await this.scheduler.markFailed(running, {
        failureClass: retryable ? "RETRYABLE" : "TERMINAL",
        reasonCode: "DISPATCH_FAILED",
        message,
        retryable,
      });
      throw Object.assign(error instanceof Error ? error : new Error(message), {
        schedulerWork: failed,
      });
    }
  }

  private async invoke(
    work: SchedulerWorkItem,
  ): Promise<{ resultRef?: string }> {
    switch (work.workKind) {
      case "INGEST_REPOSITORY":
        return this.ports.ingest(
          work.runId,
          work.projectId,
          this.ports.defaultEnvironment,
        );
      case "PLAN_RUN":
        return this.ports.plan(work.runId);
      case "VALIDATE_PLAN":
        return this.ports.validate(work.runId);
      case "ROUTE_AUTHORIZATION":
        return this.ports.routeAuthorization(work.runId);
      case "EXECUTE_PLAN":
        return this.ports.execute(work.runId);
      case "VERIFY_OUTCOME":
        return this.ports.verify(work.runId);
      case "LEARN_FROM_RUN":
        return this.ports.learn(work.runId);
      case "BUILD_OBSERVABILITY":
        return this.ports.rebuildObservability(work.projectId);
      case "DECOMPOSE_PROGRAM":
        return this.ports.decomposeProgram(work.runId);
      case "VALIDATE_PROGRAM":
        return this.ports.validateProgram(work.runId);
      case "ROUTE_PROGRAM_MATERIALIZATION":
        return this.ports.routeProgramMaterialization(work.runId);
      case "MATERIALIZE_PROGRAM":
        return this.ports.materializeProgram(work.runId);
      case "RECONCILE_PROGRAM":
        return this.ports.reconcileProgram(work.runId);
      case "VERIFY_PROGRAM":
        return this.ports.verifyProgram(work.runId);
      case "ANALYZE_PORTFOLIO":
        return this.ports.analyzePortfolio(work.runId);
      case "PLAN_PORTFOLIO":
        return this.ports.planPortfolio(work.runId);
      case "VALIDATE_PORTFOLIO":
        return this.ports.validatePortfolio(work.runId);
      case "ROUTE_PORTFOLIO_AUTHORIZATION":
        return this.ports.routePortfolioAuthorization(work.runId);
      case "MATERIALIZE_PORTFOLIO_PROGRAMS":
        return this.ports.materializePortfolioPrograms(work.runId);
      case "RECONCILE_PORTFOLIO":
        return this.ports.reconcilePortfolio(work.runId);
      case "VERIFY_PORTFOLIO":
        return this.ports.verifyPortfolio(work.runId);
      case "REBALANCE_PORTFOLIO":
        return this.ports.rebalancePortfolio(work.runId);
      default: {
        const _exhaustive: never = work.workKind;
        return _exhaustive;
      }
    }
  }
}

function isSafeRetryable(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code =
    "code" in error && typeof error.code === "string" ? error.code : "";
  return (
    code === "DATABASE_UNAVAILABLE" ||
    code === "LEASE_ALREADY_HELD" ||
    code === "DURABLE_CONFLICT" ||
    code === "SCHEDULER_CAS_CONFLICT"
  );
}
