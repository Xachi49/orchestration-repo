import { z } from "zod";
import { RepositoryIdentitySchema } from "./repository-source.js";

export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export const CommitShaSchema = z.string().regex(COMMIT_SHA_PATTERN);
export type CommitSha = z.infer<typeof CommitShaSchema>;

export const RepositoryMetadataSchema = z
  .object({
    identity: RepositoryIdentitySchema,
    defaultBranch: z.string().min(1),
    description: z.string().optional(),
    isPrivate: z.boolean(),
  })
  .strict();
export type RepositoryMetadata = z.infer<typeof RepositoryMetadataSchema>;

export const CommitMetadataSchema = z
  .object({
    sha: CommitShaSchema,
    message: z.string(),
    authorName: z.string().min(1),
    committedAt: z.string().datetime(),
  })
  .strict();
export type CommitMetadata = z.infer<typeof CommitMetadataSchema>;

export const PullRequestMetadataSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.enum(["open", "closed"]),
    headSha: CommitShaSchema,
    baseRef: z.string().min(1),
  })
  .strict();
export type PullRequestMetadata = z.infer<typeof PullRequestMetadataSchema>;

export const IssueMetadataSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.enum(["open", "closed"]),
  })
  .strict();
export type IssueMetadata = z.infer<typeof IssueMetadataSchema>;

export const CiStatusSchema = z
  .object({
    sha: CommitShaSchema,
    state: z.enum(["success", "pending", "failure", "unknown"]),
  })
  .strict();
export type CiStatus = z.infer<typeof CiStatusSchema>;

export const RemoteRepositorySnapshotSchema = z
  .object({
    projectId: z.string().min(1),
    provider: z.literal("GITHUB"),
    repositoryIdentity: RepositoryIdentitySchema,
    requestedBranch: z.string().min(1),
    resolvedCommitSha: CommitShaSchema,
    commitMetadata: CommitMetadataSchema,
    openPullRequests: z.array(PullRequestMetadataSchema),
    relevantIssues: z.array(IssueMetadataSchema),
    ciStatus: CiStatusSchema,
    observedAt: z.string().datetime(),
    snapshotVersion: z.string().min(1),
  })
  .strict();
export type RemoteRepositorySnapshot = z.infer<
  typeof RemoteRepositorySnapshotSchema
>;

export const SNAPSHOT_VERSION = "1.0.0";

export interface RemoteRepositoryRef {
  owner: string;
  repository: string;
}

/**
 * Read-only remote repository port.
 * No mutation methods. No generic HTTP escape hatch.
 */
export interface RemoteRepositoryService {
  getRepositoryMetadata(
    ref: RemoteRepositoryRef,
  ): Promise<RepositoryMetadata>;
  resolveBranchHead(
    ref: RemoteRepositoryRef,
    branch: string,
  ): Promise<CommitSha>;
  getPullRequestMetadata(
    ref: RemoteRepositoryRef,
  ): Promise<readonly PullRequestMetadata[]>;
  getIssueMetadata(
    ref: RemoteRepositoryRef,
  ): Promise<readonly IssueMetadata[]>;
  getCommitMetadata(
    ref: RemoteRepositoryRef,
    sha: string,
  ): Promise<CommitMetadata>;
  getCiStatus(ref: RemoteRepositoryRef, sha: string): Promise<CiStatus>;
}
