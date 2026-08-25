import type { Program } from "./program.js";
import type { ProgramPlan } from "./program-plan.js";
import type {
  ProgramBudgetLedger,
  ProgramBudgetReservation,
} from "./budget.js";
import type {
  ProgramCompletionRecord,
  ProgramLineageRecord,
  ProgramMaterializationApproval,
} from "./lineage.js";
import type { ProgramState } from "./program-state.js";

export interface ProgramRepository {
  create(program: Program): Promise<Program>;
  getById(programId: string): Promise<Program | null>;
  getByIdempotencyKey(key: string): Promise<Program | null>;
  save(program: Program, expectedRevision: number): Promise<Program>;
  transition(
    programId: string,
    expected: ProgramState,
    expectedRevision: number,
    next: ProgramState,
    updatedAt: string,
    extras?: Partial<
      Pick<
        Program,
        | "programPlanVersion"
        | "programPlanHash"
        | "decompositionRevisionCount"
        | "failureReasonCode"
        | "paused"
      >
    >,
  ): Promise<Program>;
  listByProject(projectId: string): Promise<readonly Program[]>;
  listByStates(
    states: readonly ProgramState[],
    limit: number,
  ): Promise<readonly Program[]>;
}

export interface ProgramPlanRepository {
  save(plan: ProgramPlan): Promise<ProgramPlan>;
  get(
    programId: string,
    programPlanVersion: number,
  ): Promise<ProgramPlan | null>;
  getLatest(programId: string): Promise<ProgramPlan | null>;
}

export interface ProgramBudgetLedgerRepository {
  create(ledger: ProgramBudgetLedger): Promise<ProgramBudgetLedger>;
  get(programId: string): Promise<ProgramBudgetLedger | null>;
  saveCas(
    ledger: ProgramBudgetLedger,
    expectedRevision: number,
  ): Promise<ProgramBudgetLedger>;
}

export interface ProgramBudgetReservationRepository {
  save(
    reservation: ProgramBudgetReservation,
  ): Promise<ProgramBudgetReservation>;
  getById(
    reservationId: string,
  ): Promise<ProgramBudgetReservation | null>;
  listByProgram(
    programId: string,
  ): Promise<readonly ProgramBudgetReservation[]>;
}

export interface ProgramLineageRepository {
  save(record: ProgramLineageRecord): Promise<ProgramLineageRecord>;
  getById(lineageId: string): Promise<ProgramLineageRecord | null>;
  listByProgram(
    programId: string,
  ): Promise<readonly ProgramLineageRecord[]>;
  listByPlan(
    programId: string,
    programPlanVersion: number,
  ): Promise<readonly ProgramLineageRecord[]>;
}

export interface ProgramMaterializationApprovalRepository {
  save(
    approval: ProgramMaterializationApproval,
  ): Promise<ProgramMaterializationApproval>;
  getById(
    approvalId: string,
  ): Promise<ProgramMaterializationApproval | null>;
  getPendingByProgram(
    programId: string,
  ): Promise<ProgramMaterializationApproval | null>;
}

export interface ProgramCompletionRepository {
  save(record: ProgramCompletionRecord): Promise<ProgramCompletionRecord>;
  getByProgram(
    programId: string,
  ): Promise<ProgramCompletionRecord | null>;
}
