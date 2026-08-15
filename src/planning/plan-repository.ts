import { z } from "zod";
import {
  PlanVersionSchema,
  type ExecutionPlan,
  type PlanVersion,
} from "../domain/plan/execution-plan.js";

export const StoredPlanStatusSchema = z.enum([
  "CANDIDATE",
  "READY_FOR_VALIDATION",
  "UNDER_VALIDATION",
  "VALIDATED_PASS",
  "VALIDATED_BLOCK",
  "VALIDATED_APPROVAL_REQUIRED",
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
    supersedesPlanId: z.string().min(1).optional(),
    lineageRootPlanId: z.string().min(1).optional(),
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
  listByRunId(runId: string): Promise<readonly StoredPlanRecord[]>;
  exists(planId: string): Promise<boolean>;
  markSuperseded(planId: string): Promise<StoredPlanRecord>;
}

/**
 * In-memory multi-version plan store.
 * Latest plan per run is tracked separately; prior versions remain addressable.
 */
export class InMemoryPlanRepository implements PlanRepository {
  private readonly byId = new Map<string, StoredPlanRecord>();
  private readonly latestByRun = new Map<string, string>();
  private readonly versionsByRun = new Map<string, Map<number, string>>();

  async save(record: StoredPlanRecord): Promise<StoredPlanRecord> {
    const parsed = StoredPlanRecordSchema.parse(record);
    const versionMap =
      this.versionsByRun.get(parsed.runId) ?? new Map<number, string>();
    const existingForVersion = versionMap.get(parsed.planVersion);
    if (existingForVersion && existingForVersion !== parsed.planId) {
      throw new Error(
        `Run ${parsed.runId} already has planVersion ${parsed.planVersion} (${existingForVersion})`,
      );
    }
    this.byId.set(parsed.planId, parsed);
    versionMap.set(parsed.planVersion, parsed.planId);
    this.versionsByRun.set(parsed.runId, versionMap);
    this.latestByRun.set(parsed.runId, parsed.planId);
    return parsed;
  }

  async getById(planId: string): Promise<StoredPlanRecord | null> {
    return this.byId.get(planId) ?? null;
  }

  async getByRunId(runId: string): Promise<StoredPlanRecord | null> {
    const planId = this.latestByRun.get(runId);
    if (!planId) {
      return null;
    }
    return this.byId.get(planId) ?? null;
  }

  async getVersion(
    runId: string,
    planVersion: PlanVersion,
  ): Promise<StoredPlanRecord | null> {
    const planId = this.versionsByRun.get(runId)?.get(planVersion);
    if (!planId) {
      return null;
    }
    return this.byId.get(planId) ?? null;
  }

  async listByRunId(runId: string): Promise<readonly StoredPlanRecord[]> {
    const versionMap = this.versionsByRun.get(runId);
    if (!versionMap) {
      return [];
    }
    return [...versionMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, planId]) => this.byId.get(planId)!)
      .filter(Boolean);
  }

  async exists(planId: string): Promise<boolean> {
    return this.byId.has(planId);
  }

  async markSuperseded(planId: string): Promise<StoredPlanRecord> {
    const existing = this.byId.get(planId);
    if (!existing) {
      throw new Error(`Unknown planId: ${planId}`);
    }
    const next = StoredPlanRecordSchema.parse({
      ...existing,
      status: "SUPERSEDED",
    });
    this.byId.set(planId, next);
    return next;
  }
}
