import { z } from "zod";
import { ObjectiveVersionSchema } from "../domain/objective/objective.js";
import { RunStateSchema, type RunState } from "../domain/run/run-state.js";

export const RunRecordSchema = z
  .object({
    runId: z.string().min(1),
    projectId: z.string().min(1),
    objectiveId: z.string().min(1),
    objectiveVersion: ObjectiveVersionSchema,
    /**
     * Which immutable attempt executes this objective version.
     * Historical payloads that omit the field hydrate as 1.
     * Ordinary admission is always 1. Governed replacement increments it.
     * Distinct from objectiveVersion, planVersion, and recordRevision.
     */
    runAttempt: z.number().int().positive().default(1),
    /**
     * Idempotency identity that authorized creation of this run.
     * Ordinary admission stores objectiveIdempotencyKey(...).
     * Governed replacement stores runReplacementIdempotencyKey(...).
     * Not every run's key equals the ordinary objective admission key.
     */
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
   * Highest runAttempt for this objective identity and environment, or 0
   * when none exist. Callers derive the next attempt; they do not scan
   * and mint attempts from ordinary admission.
   */
  maxRunAttempt(identity: {
    projectId: string;
    objectiveId: string;
    objectiveVersion: number;
    requestedEnvironment: string;
  }): Promise<number>;
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

/**
 * Hydrate a stored run so the physical run_attempt column and the JSON
 * payload cannot silently disagree.
 *
 * A historical payload that omits runAttempt takes the column value
 * (migration default 1). An explicit payload value that differs from the
 * column fails closed.
 */
export function reconcilePersistedRun(input: {
  payload: unknown;
  runAttempt: number;
  recordRevision: number;
}): RunRecord {
  if (
    input.payload === null ||
    typeof input.payload !== "object" ||
    Array.isArray(input.payload)
  ) {
    throw new Error("Persisted run payload is not an object");
  }
  if (!Number.isInteger(input.runAttempt) || input.runAttempt < 1) {
    throw new Error(`runAttempt column is invalid: ${input.runAttempt}`);
  }
  const raw = input.payload as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(raw, "runAttempt") &&
    raw["runAttempt"] !== input.runAttempt
  ) {
    throw new Error(
      `runAttempt column ${input.runAttempt} disagrees with payload ${String(raw["runAttempt"])}`,
    );
  }
  return RunRecordSchema.parse({
    ...raw,
    runAttempt: input.runAttempt,
    recordRevision: input.recordRevision,
  });
}
