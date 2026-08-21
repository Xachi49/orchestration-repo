import { z } from "zod";
import { PRIORITY_CLASSES } from "./priority.js";
import { SCHEDULER_WORK_KINDS } from "./work-kind.js";
import { SCHEDULING_REASON_CODES } from "./score.js";

export const SchedulerDecisionRecordSchema = z
  .object({
    decisionId: z.string().min(1),
    timestamp: z.string().datetime(),
    candidateWorkIds: z.array(z.string().min(1)),
    selectedWorkId: z.string().min(1).nullable(),
    priorityInputs: z.record(z.string(), z.unknown()),
    fairnessInputs: z.record(z.string(), z.unknown()),
    capacityState: z.record(z.string(), z.unknown()),
    reasonCode: z.enum(SCHEDULING_REASON_CODES),
    score: z.number().optional(),
    workKind: z.enum(SCHEDULER_WORK_KINDS).optional(),
    priorityClass: z.enum(PRIORITY_CLASSES).optional(),
    projectId: z.string().min(1).optional(),
  })
  .strict();

export type SchedulerDecisionRecord = z.infer<
  typeof SchedulerDecisionRecordSchema
>;

export function parseSchedulerDecisionRecord(
  input: unknown,
): SchedulerDecisionRecord {
  return SchedulerDecisionRecordSchema.parse(input);
}

export const SchedulerProjectConfigSchema = z
  .object({
    projectId: z.string().min(1),
    weight: z.number().int().min(1).max(10).default(1),
    maxConcurrency: z.number().int().min(1).max(64).default(4),
    defaultPriorityClass: z.enum(PRIORITY_CLASSES).default("NORMAL"),
    recordRevision: z.number().int().positive().default(1),
  })
  .strict();

export type SchedulerProjectConfig = z.infer<
  typeof SchedulerProjectConfigSchema
>;

export function parseSchedulerProjectConfig(
  input: unknown,
): SchedulerProjectConfig {
  return SchedulerProjectConfigSchema.parse(input);
}

export const SchedulerPauseScopeSchema = z.enum(["GLOBAL", "PROJECT"]);
export type SchedulerPauseScope = z.infer<typeof SchedulerPauseScopeSchema>;

export const SchedulerPauseRecordSchema = z
  .object({
    pauseId: z.string().min(1),
    scope: SchedulerPauseScopeSchema,
    projectId: z.string().min(1).optional(),
    paused: z.boolean(),
    updatedAt: z.string().datetime(),
    updatedByPrincipalId: z.string().min(1),
    recordRevision: z.number().int().positive(),
  })
  .strict();

export type SchedulerPauseRecord = z.infer<typeof SchedulerPauseRecordSchema>;

export function parseSchedulerPauseRecord(
  input: unknown,
): SchedulerPauseRecord {
  return SchedulerPauseRecordSchema.parse(input);
}

export interface PortfolioSnapshot {
  capturedAt: string;
  projectsActive: number;
  runsActive: number;
  workWaiting: number;
  workEligible: number;
  workClaimed: number;
  workRunning: number;
  workBlockedDependency: number;
  workByKind: Record<string, number>;
  oldestEligibleAgeMs: number | null;
  capacityUtilization: number;
  dependencyBlockedCount: number;
  globalPaused: boolean;
}
