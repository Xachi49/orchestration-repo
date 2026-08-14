/**
 * Executor authority boundary.
 * May execute only previously authorized actions.
 * Cannot create plans or approvals.
 * Phase 0: no active execution implementation.
 */
export interface ExecutorPort {
  readonly authority: "EXECUTE_AUTHORIZED_ONLY";
}

export const EXECUTOR_AUTHORITY = {
  mayExecuteAuthorizedActions: true,
  mayCreatePlans: false,
  mayCreateApprovals: false,
} as const;

/** Intentionally unimplemented — execution is deferred past Phase 0. */
export class ExecutionNotImplementedError extends Error {
  readonly code = "EXECUTION_NOT_IMPLEMENTED" as const;
  constructor() {
    super("Execution is intentionally unimplemented in Phase 0");
    this.name = "ExecutionNotImplementedError";
  }
}
