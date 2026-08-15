import { z } from "zod";
import {
  PlanVersionSchema,
  type ExecutionPlan,
  type PlanVersion,
} from "../domain/plan/execution-plan.js";

export const StoredPlanStatusSchema = z.enum([
  "CANDIDATE",
  "READY_FOR_VALIDATION",
  "SUPERSEDED",
]);
export type StoredPlanStatus = z.infer<typeof StoredPlanStatusSchema>;

export const StoredPlanRecordSchema = z
  .object({
    planId: z.string().min(1),
    runId: z.string().min(1),
    planVersion: PlanVersionSchema,
    status: StoredPlanStatusSchema,
    plan: z.custom<ExecutionPlan>(),
    planHash: z.string().min(1),
    planningContextFingerprint: z.string().min(1),
    planningPromptVersion: z.string().min(1),
    modelProvider: z.string().min(1),
    modelId: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();
export type StoredPlanRecord = z.infer<typeof StoredPlanRecordSchema>;

export interface PlanRepository {
  save(record: StoredPlanRecord): Promise<StoredPlanRecord>;
  getById(planId: string): Promise<StoredPlanRecord | null>;
  getByRunId(runId: string): Promise<StoredPlanRecord | null>;
  getVersion(
    runId: string,
    planVersion: PlanVersion,
  ): Promise<StoredPlanRecord | null>;
  exists(planId: string): Promise<boolean>;
}

export class InMemoryPlanRepository implements PlanRepository {
  private readonly byId = new Map<string, StoredPlanRecord>();
  private readonly byRun = new Map<string, string>();

  async save(record: StoredPlanRecord): Promise<StoredPlanRecord> {
    const parsed = StoredPlanRecordSchema.parse(record);
    const existingRunPlan = this.byRun.get(parsed.runId);
    if (
      existingRunPlan &&
      existingRunPlan !== parsed.planId &&
      parsed.planVersion === 1
    ) {
      throw new Error(
        `Run ${parsed.runId} already has planVersion 1 (${existingRunPlan})`,
      );
    }
    this.byId.set(parsed.planId, parsed);
    this.byRun.set(parsed.runId, parsed.planId);
    return parsed;
  }

  async getById(planId: string): Promise<StoredPlanRecord | null> {
    return this.byId.get(planId) ?? null;
  }

  async getByRunId(runId: string): Promise<StoredPlanRecord | null> {
    const planId = this.byRun.get(runId);
    if (!planId) {
      return null;
    }
    return this.byId.get(planId) ?? null;
  }

  async getVersion(
    runId: string,
    planVersion: PlanVersion,
  ): Promise<StoredPlanRecord | null> {
    const record = await this.getByRunId(runId);
    if (!record || record.planVersion !== planVersion) {
      return null;
    }
    return record;
  }

  async exists(planId: string): Promise<boolean> {
    return this.byId.has(planId);
  }
}
