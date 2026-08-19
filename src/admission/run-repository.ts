import { z } from "zod";
import { ObjectiveVersionSchema } from "../domain/objective/objective.js";
import { RunStateSchema, type RunState } from "../domain/run/run-state.js";

export const RunRecordSchema = z
  .object({
    runId: z.string().min(1),
    projectId: z.string().min(1),
    objectiveId: z.string().min(1),
    objectiveVersion: ObjectiveVersionSchema,
    idempotencyKey: z.string().min(1),
    requesterId: z.string().min(1),
    requestedEnvironment: z.string().min(1),
    state: RunStateSchema,
    /** Persistence concurrency metadata only — not objective/plan/precedent version. */
    recordRevision: z.number().int().min(1).default(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    correlationId: z.string().min(1),
    traceId: z.string().min(1),
    admittedAt: z.string().datetime().optional(),
    failureReasonCode: z.string().min(1).optional(),
  })
  .strict();

export type RunRecord = z.infer<typeof RunRecordSchema>;

/**
 * Durable run persistence. The state machine validates transitions;
 * this port only stores the resulting record.
 * Future stores must atomically coordinate run persistence, event persistence,
 * and idempotency binding (transaction or outbox). In-memory adapters do not.
 */
export interface RunRepository {
  create(record: RunRecord): Promise<RunRecord>;
  getById(runId: string): Promise<RunRecord | null>;
  exists(runId: string): Promise<boolean>;
  save(record: RunRecord): Promise<RunRecord>;
  listByProject(projectId: string): Promise<readonly RunRecord[]>;
  /**
   * Compare-and-set run state. Succeeds only when the stored state equals
   * `expected`. Durable adapters must use UPDATE ... WHERE state = expected.
   */
  transition(
    runId: string,
    expected: RunState,
    expectedRecordRevision: number,
    next: RunState,
    updatedAt: string,
    extras?: { admittedAt?: string; failureReasonCode?: string },
  ): Promise<RunRecord>;
}

export function withRunState(
  record: RunRecord,
  state: RunState,
  updatedAt: string,
  extras: { admittedAt?: string; failureReasonCode?: string } = {},
): RunRecord {
  const next: RunRecord = {
    ...record,
    state,
    updatedAt,
  };
  if (extras.admittedAt !== undefined) {
    next.admittedAt = extras.admittedAt;
  }
  if (extras.failureReasonCode !== undefined) {
    next.failureReasonCode = extras.failureReasonCode;
  }
  return next;
}
