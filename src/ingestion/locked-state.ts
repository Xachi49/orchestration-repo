import { z } from "zod";
import { CommitShaSchema } from "./remote-repository.js";
import { RepositoryIdentitySchema } from "./repository-source.js";

export const LockedRepositoryStatusSchema = z.enum([
  "LOCKED",
  "VERIFIED",
  "STALE",
  "INVALID",
]);
export type LockedRepositoryStatus = z.infer<
  typeof LockedRepositoryStatusSchema
>;

export const LockedRepositoryStateSchema = z
  .object({
    runId: z.string().min(1),
    projectId: z.string().min(1),
    repositoryIdentity: RepositoryIdentitySchema,
    branch: z.string().min(1),
    commitSha: CommitShaSchema,
    lockedAt: z.string().datetime(),
    remoteSnapshotHash: z.string().min(1),
    status: LockedRepositoryStatusSchema,
  })
  .strict();
export type LockedRepositoryState = z.infer<typeof LockedRepositoryStateSchema>;

export interface LockedRepositoryStore {
  getByRunId(runId: string): Promise<LockedRepositoryState | null>;
  save(state: LockedRepositoryState): Promise<LockedRepositoryState>;
}
