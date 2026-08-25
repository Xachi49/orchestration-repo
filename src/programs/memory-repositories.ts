import type { Program } from "./program.js";
import { parseProgram } from "./program.js";
import type { ProgramPlan } from "./program-plan.js";
import { parseProgramPlan } from "./program-plan.js";
import type {
  ProgramBudgetLedger,
  ProgramBudgetReservation,
} from "./budget.js";
import {
  ProgramBudgetLedgerSchema,
  ProgramBudgetReservationSchema,
} from "./budget.js";
import type {
  ProgramCompletionRecord,
  ProgramLineageRecord,
  ProgramMaterializationApproval,
} from "./lineage.js";
import {
  ProgramCompletionRecordSchema,
  ProgramLineageRecordSchema,
  ProgramMaterializationApprovalSchema,
} from "./lineage.js";
import { ProgramError } from "./errors.js";
import {
  canTransitionProgram,
  type ProgramState,
} from "./program-state.js";
import type {
  ProgramBudgetLedgerRepository,
  ProgramBudgetReservationRepository,
  ProgramCompletionRepository,
  ProgramLineageRepository,
  ProgramMaterializationApprovalRepository,
  ProgramPlanRepository,
  ProgramRepository,
} from "./repositories.js";

export class InMemoryProgramRepository implements ProgramRepository {
  private readonly byId = new Map<string, Program>();
  private readonly byIdem = new Map<string, string>();

  async create(program: Program): Promise<Program> {
    const parsed = parseProgram(program);
    if (this.byId.has(parsed.programId)) {
      throw new ProgramError(
        "PROGRAM_CAS_CONFLICT",
        `Program ${parsed.programId} already exists`,
      );
    }
    this.byId.set(parsed.programId, parsed);
    this.byIdem.set(parsed.idempotencyKey, parsed.programId);
    return parsed;
  }

  async getById(programId: string): Promise<Program | null> {
    return this.byId.get(programId) ?? null;
  }

  async getByIdempotencyKey(key: string): Promise<Program | null> {
    const id = this.byIdem.get(key);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async save(program: Program, expectedRevision: number): Promise<Program> {
    const existing = this.byId.get(program.programId);
    if (!existing || existing.recordRevision !== expectedRevision) {
      throw new ProgramError(
        "PROGRAM_CAS_CONFLICT",
        `CAS conflict for program ${program.programId}`,
      );
    }
    const next = parseProgram({
      ...program,
      recordRevision: expectedRevision + 1,
    });
    this.byId.set(next.programId, next);
    return next;
  }

  async transition(
    programId: string,
    expected: ProgramState,
    expectedRevision: number,
    next: ProgramState,
    updatedAt: string,
    extras: Partial<
      Pick<
        Program,
        | "programPlanVersion"
        | "programPlanHash"
        | "decompositionRevisionCount"
        | "failureReasonCode"
        | "paused"
      >
    > = {},
  ): Promise<Program> {
    const existing = this.byId.get(programId);
    if (!existing) {
      throw new ProgramError("PROGRAM_NOT_FOUND", `Program ${programId} missing`);
    }
    if (
      existing.status !== expected ||
      existing.recordRevision !== expectedRevision
    ) {
      throw new ProgramError(
        "PROGRAM_STATE_CONFLICT",
        `Program ${programId} state/revision mismatch`,
      );
    }
    if (!canTransitionProgram(expected, next)) {
      throw new ProgramError(
        "INVALID_PROGRAM_TRANSITION",
        `Illegal transition ${expected} → ${next}`,
      );
    }
    const updated = parseProgram({
      ...existing,
      ...extras,
      status: next,
      updatedAt,
      recordRevision: expectedRevision + 1,
    });
    this.byId.set(programId, updated);
    return updated;
  }

  async listByProject(projectId: string): Promise<readonly Program[]> {
    return [...this.byId.values()].filter((p) => p.projectId === projectId);
  }

  async listByStates(
    states: readonly ProgramState[],
    limit: number,
  ): Promise<readonly Program[]> {
    const set = new Set(states);
    return [...this.byId.values()]
      .filter((p) => set.has(p.status))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit);
  }
}

export class InMemoryProgramPlanRepository implements ProgramPlanRepository {
  private readonly plans = new Map<string, ProgramPlan>();

  private key(programId: string, version: number): string {
    return `${programId}:${version}`;
  }

  async save(plan: ProgramPlan): Promise<ProgramPlan> {
    const parsed = parseProgramPlan(plan);
    const k = this.key(parsed.programId, parsed.programPlanVersion);
    if (this.plans.has(k)) {
      throw new ProgramError(
        "PROGRAM_CAS_CONFLICT",
        `Plan ${k} already immutable`,
      );
    }
    this.plans.set(k, parsed);
    return parsed;
  }

  async get(
    programId: string,
    programPlanVersion: number,
  ): Promise<ProgramPlan | null> {
    return this.plans.get(this.key(programId, programPlanVersion)) ?? null;
  }

  async getLatest(programId: string): Promise<ProgramPlan | null> {
    const versions = [...this.plans.values()]
      .filter((p) => p.programId === programId)
      .sort((a, b) => b.programPlanVersion - a.programPlanVersion);
    return versions[0] ?? null;
  }
}

export class InMemoryProgramBudgetLedgerRepository
  implements ProgramBudgetLedgerRepository
{
  private readonly ledgers = new Map<string, ProgramBudgetLedger>();

  async create(ledger: ProgramBudgetLedger): Promise<ProgramBudgetLedger> {
    const parsed = ProgramBudgetLedgerSchema.parse(ledger);
    this.ledgers.set(parsed.programId, parsed);
    return parsed;
  }

  async get(programId: string): Promise<ProgramBudgetLedger | null> {
    return this.ledgers.get(programId) ?? null;
  }

  async saveCas(
    ledger: ProgramBudgetLedger,
    expectedRevision: number,
  ): Promise<ProgramBudgetLedger> {
    const existing = this.ledgers.get(ledger.programId);
    if (!existing || existing.recordRevision !== expectedRevision) {
      throw new ProgramError(
        "PROGRAM_BUDGET_OVER_ALLOCATION",
        `Budget CAS conflict for ${ledger.programId}`,
      );
    }
    const next = ProgramBudgetLedgerSchema.parse({
      ...ledger,
      recordRevision: expectedRevision + 1,
    });
    this.ledgers.set(next.programId, next);
    return next;
  }
}

export class InMemoryProgramBudgetReservationRepository
  implements ProgramBudgetReservationRepository
{
  private readonly byId = new Map<string, ProgramBudgetReservation>();

  async save(
    reservation: ProgramBudgetReservation,
  ): Promise<ProgramBudgetReservation> {
    const parsed = ProgramBudgetReservationSchema.parse(reservation);
    this.byId.set(parsed.reservationId, parsed);
    return parsed;
  }

  async getById(
    reservationId: string,
  ): Promise<ProgramBudgetReservation | null> {
    return this.byId.get(reservationId) ?? null;
  }

  async listByProgram(
    programId: string,
  ): Promise<readonly ProgramBudgetReservation[]> {
    return [...this.byId.values()].filter((r) => r.programId === programId);
  }
}

export class InMemoryProgramLineageRepository
  implements ProgramLineageRepository
{
  private readonly byId = new Map<string, ProgramLineageRecord>();

  async save(record: ProgramLineageRecord): Promise<ProgramLineageRecord> {
    const parsed = ProgramLineageRecordSchema.parse(record);
    this.byId.set(parsed.lineageId, parsed);
    return parsed;
  }

  async getById(lineageId: string): Promise<ProgramLineageRecord | null> {
    return this.byId.get(lineageId) ?? null;
  }

  async listByProgram(
    programId: string,
  ): Promise<readonly ProgramLineageRecord[]> {
    return [...this.byId.values()].filter((r) => r.programId === programId);
  }

  async listByPlan(
    programId: string,
    programPlanVersion: number,
  ): Promise<readonly ProgramLineageRecord[]> {
    return [...this.byId.values()].filter(
      (r) =>
        r.programId === programId &&
        r.programPlanVersion === programPlanVersion,
    );
  }
}

export class InMemoryProgramMaterializationApprovalRepository
  implements ProgramMaterializationApprovalRepository
{
  private readonly byId = new Map<string, ProgramMaterializationApproval>();

  async save(
    approval: ProgramMaterializationApproval,
  ): Promise<ProgramMaterializationApproval> {
    const parsed = ProgramMaterializationApprovalSchema.parse(approval);
    this.byId.set(parsed.approvalId, parsed);
    return parsed;
  }

  async getById(
    approvalId: string,
  ): Promise<ProgramMaterializationApproval | null> {
    return this.byId.get(approvalId) ?? null;
  }

  async getPendingByProgram(
    programId: string,
  ): Promise<ProgramMaterializationApproval | null> {
    return (
      [...this.byId.values()].find(
        (a) => a.programId === programId && a.status === "PENDING",
      ) ?? null
    );
  }
}

export class InMemoryProgramCompletionRepository
  implements ProgramCompletionRepository
{
  private readonly byProgram = new Map<string, ProgramCompletionRecord>();

  async save(
    record: ProgramCompletionRecord,
  ): Promise<ProgramCompletionRecord> {
    const parsed = ProgramCompletionRecordSchema.parse(record);
    if (this.byProgram.has(parsed.programId)) {
      return this.byProgram.get(parsed.programId)!;
    }
    this.byProgram.set(parsed.programId, parsed);
    return parsed;
  }

  async getByProgram(
    programId: string,
  ): Promise<ProgramCompletionRecord | null> {
    return this.byProgram.get(programId) ?? null;
  }
}
