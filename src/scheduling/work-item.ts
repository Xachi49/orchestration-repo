import { z } from "zod";
import { PRIORITY_CLASSES } from "./priority.js";
import { SCHEDULER_WORK_KINDS } from "./work-kind.js";

export const WORK_ITEM_STATUSES = [
  "WAITING",
  "BLOCKED_DEPENDENCY",
  "ELIGIBLE",
  "CLAIMED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CONTAINED",
  "CANCELLED",
] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const TERMINAL_WORK_STATUSES = [
  "SUCCEEDED",
  "FAILED",
  "CONTAINED",
  "CANCELLED",
] as const;

export type TerminalWorkStatus = (typeof TERMINAL_WORK_STATUSES)[number];

export function isTerminalWorkStatus(
  status: WorkItemStatus,
): status is TerminalWorkStatus {
  return (TERMINAL_WORK_STATUSES as readonly string[]).includes(status);
}

export const SchedulerWorkItemSchema = z
  .object({
    workItemId: z.string().min(1),
    projectId: z.string().min(1),
    runId: z.string().min(1),
    workKind: z.enum(SCHEDULER_WORK_KINDS),
    status: z.enum(WORK_ITEM_STATUSES),
    priorityClass: z.enum(PRIORITY_CLASSES),
    logicalIdentityKey: z.string().min(1),
    bindingHash: z.string().min(1),
    createdAt: z.string().datetime(),
    eligibleAt: z.string().datetime(),
    deadlineAt: z.string().datetime().optional(),
    attemptCount: z.number().int().min(0),
    maxAttempts: z.number().int().positive(),
    recordRevision: z.number().int().positive(),
    dependencySetHash: z.string().min(1),
    schedulingMetadataHash: z.string().min(1),
    claimOwnerId: z.string().min(1).optional(),
    fenceToken: z.number().int().nonnegative().optional(),
    leaseExpiresAt: z.string().datetime().optional(),
    failureClass: z.string().min(1).optional(),
    failureReasonCode: z.string().min(1).optional(),
    lastErrorSafeMessage: z.string().max(2000).optional(),
    resultRef: z.string().min(1).optional(),
    lastDecisionId: z.string().min(1).optional(),
  })
  .strict();

export type SchedulerWorkItem = z.infer<typeof SchedulerWorkItemSchema>;

export function parseSchedulerWorkItem(input: unknown): SchedulerWorkItem {
  return SchedulerWorkItemSchema.parse(input);
}

export const DEFAULT_WORK_MAX_ATTEMPTS = 5;
