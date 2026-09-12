import { z } from "zod";
import { RunRecordSchema } from "../admission/run-repository.js";
import type { TimelineStageView } from "./timeline.js";

export const ControlTowerDashboardSchema = z
  .object({
    counts: z
      .object({
        active: z.number().int().nonnegative(),
        awaitingApproval: z.number().int().nonnegative(),
        executing: z.number().int().nonnegative(),
        verifying: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        blockedOrFailed: z.number().int().nonnegative(),
      })
      .strict(),
    recentRuns: z.array(RunRecordSchema),
    recentApprovals: z.array(
      z
        .object({
          approvalRequestId: z.string(),
          runId: z.string(),
          projectId: z.string(),
          objectiveId: z.string(),
          status: z.string(),
          expiresAt: z.string(),
          validationDecision: z.string(),
        })
        .strict(),
    ),
    recentCompletions: z.array(
      z
        .object({
          runId: z.string(),
          projectId: z.string(),
          completedAt: z.string(),
        })
        .strict(),
    ),
    doctrine: z
      .object({
        controlTowerNotAuthority: z.literal("CONTROL TOWER != AUTHORITY"),
        liveNotReady: z.literal("LIVE != READY"),
      })
      .strict(),
  })
  .strict();

export type ControlTowerDashboard = z.infer<typeof ControlTowerDashboardSchema>;

export const RunDetailReadModelSchema = z
  .object({
    run: RunRecordSchema,
    timeline: z.array(
      z
        .object({
          stageId: z.string(),
          label: z.string(),
          status: z.string(),
        })
        .strict(),
    ),
    objective: z.unknown().nullable(),
    repositoryContext: z.unknown().nullable(),
    plan: z.unknown().nullable(),
    validation: z.unknown().nullable(),
    approvalRequest: z.unknown().nullable(),
    authorization: z.unknown().nullable(),
    execution: z.unknown().nullable(),
    verification: z.unknown().nullable(),
    completion: z.unknown().nullable(),
    doctrine: z
      .object({
        passNotApproved: z.literal("PASS != APPROVED"),
        executionSucceededNotVerified: z.string(),
        verifiedSuccessNotCompleted: z.literal(
          "VERIFIED_SUCCESS != COMPLETED",
        ),
      })
      .strict(),
  })
  .strict();

export type RunDetailReadModel = z.infer<typeof RunDetailReadModelSchema> & {
  timeline: TimelineStageView[];
};
