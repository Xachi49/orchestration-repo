import { z } from "zod";
import { EvidenceRecordSchema } from "../domain/evidence/evidence.js";
import { LockedRepositoryStateSchema } from "./locked-state.js";
import { ProjectIndexSchema } from "./index-model.js";
import { RemoteRepositorySnapshotSchema } from "./remote-repository.js";
import { CONTEXT_SCHEMA_VERSION } from "./index-model.js";

export const VerifiedRepositoryContextStatusSchema = z.literal("VERIFIED");
export type VerifiedRepositoryContextStatus = z.infer<
  typeof VerifiedRepositoryContextStatusSchema
>;

export const VerifiedRepositoryContextSchema = z
  .object({
    schemaVersion: z.literal(CONTEXT_SCHEMA_VERSION),
    status: VerifiedRepositoryContextStatusSchema,
    runId: z.string().min(1),
    projectId: z.string().min(1),
    environment: z.string().min(1),
    lockedRepository: LockedRepositoryStateSchema,
    remoteSnapshot: RemoteRepositorySnapshotSchema,
    repositoryFingerprint: z.string().min(1),
    projectIndex: ProjectIndexSchema,
    evidenceIds: z.array(z.string().min(1)),
    observedAt: z.string().datetime(),
    verifiedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status !== "VERIFIED") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "VerifiedRepositoryContext may only be persisted as VERIFIED",
        path: ["status"],
      });
    }
    if (value.lockedRepository.status !== "VERIFIED") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "VerifiedRepositoryContext requires lockedRepository.status VERIFIED",
        path: ["lockedRepository", "status"],
      });
    }
  });
export type VerifiedRepositoryContext = z.infer<
  typeof VerifiedRepositoryContextSchema
>;

export interface VerifiedRepositoryContextStore {
  getByRunId(runId: string): Promise<VerifiedRepositoryContext | null>;
  save(
    context: VerifiedRepositoryContext,
  ): Promise<VerifiedRepositoryContext>;
}

export interface EvidenceRegistry {
  put(record: z.infer<typeof EvidenceRecordSchema>): Promise<z.infer<typeof EvidenceRecordSchema>>;
  getById(evidenceId: string): Promise<z.infer<typeof EvidenceRecordSchema> | null>;
  listByRunId(runId: string): Promise<readonly z.infer<typeof EvidenceRecordSchema>[]>;
}

/**
 * Phase 4 prerequisite helper: INGESTING → PLANNING may occur only when a
 * VERIFIED repository context exists and the live locked repository state is
 * still VERIFIED (not STALE/INVALID).
 */
export function isVerifiedReadyForPlanning(input: {
  context: VerifiedRepositoryContext | null;
  liveLockedState: z.infer<typeof LockedRepositoryStateSchema> | null;
}): boolean {
  const { context, liveLockedState } = input;
  if (!context || context.status !== "VERIFIED") {
    return false;
  }
  if (!liveLockedState || liveLockedState.status !== "VERIFIED") {
    return false;
  }
  return (
    liveLockedState.commitSha.toLowerCase() ===
      context.lockedRepository.commitSha.toLowerCase() &&
    liveLockedState.runId === context.runId
  );
}
